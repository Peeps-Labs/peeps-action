"""The pytest side of peeps-action: loaded with ``-p peeps_pytest_plugin``.

It does two things, each switched on by an environment variable the action
sets, and nothing at all when neither is set:

``PEEPS_COLLECT_OUT``
    After collection, write what pytest collected to that file as JSON: one
    entry per item, in the shape Peeps' runner contract names (``nodeId``,
    ``browser``, ``line``, ``markers``), plus pytest's rootdir, the modules
    that failed to collect, and whether pytest-playwright is loaded. It reads
    only what collection itself produced; it imports nothing of the
    repository's.

``PEEPS_PLAN_FILE``
    While tests run, stream ``run_start`` / ``test_start`` / ``test_end`` /
    ``run_end`` for every planned node id to ``POST /api/v1/runs/{id}/events``,
    the same events the action's Playwright reporter sends. The plan maps node
    ids to Peeps run ids and per-run credentials; the action wrote it.
    ``PEEPS_RESULTS_OUT`` additionally records, per node id, the directory
    pytest-playwright wrote that test's traces, screenshots and videos to, so
    the action can upload them under the run they belong to.

Standard library only: this runs inside the customer's Python, whatever it has.
"""

from __future__ import annotations

import json
import os
import queue
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

import pytest

USER_AGENT = "peeps-action/0.1"

#: The user property a test's pytest-playwright output directory rides on.
OUTPUT_DIR_PROPERTY = "peeps_output_dir"


def _write_json(path: str, value: Any) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle)


# ---------------------------------------------------------------------------
# Collection
# ---------------------------------------------------------------------------


def _browser_of(item: Any) -> Optional[str]:
    callspec = getattr(item, "callspec", None)
    if callspec is None:
        return None
    browser = callspec.params.get("browser_name")
    return browser if isinstance(browser, str) else None


def _line_of(item: Any) -> Optional[int]:
    line = item.location[1]
    return line + 1 if isinstance(line, int) else None


class _Collector:
    def __init__(self, out: str) -> None:
        self.out = out
        self.errors: List[Dict[str, str]] = []

    @pytest.hookimpl(trylast=True)
    def pytest_collectreport(self, report: Any) -> None:
        if report.failed:
            self.errors.append(
                {"nodeId": report.nodeid, "message": report.longreprtext[-2000:]}
            )

    @pytest.hookimpl(trylast=True)
    def pytest_collection_finish(self, session: Any) -> None:
        config = session.config
        items = [
            {
                "nodeId": item.nodeid,
                "browser": _browser_of(item),
                "line": _line_of(item),
                "markers": [marker.name for marker in item.iter_markers()],
            }
            for item in session.items
        ]
        _write_json(
            self.out,
            {
                "rootDir": str(config.rootpath),
                "iniPath": str(config.inipath) if config.inipath else None,
                "playwright": config.pluginmanager.hasplugin("playwright"),
                "items": items,
                "errors": self.errors,
            },
        )


# ---------------------------------------------------------------------------
# Running: phases -> one Peeps status per test
# ---------------------------------------------------------------------------


def settle(phases: List[Dict[str, Any]]) -> Dict[str, Any]:
    """The status Peeps records for one test, from its setup/call/teardown.

    Peeps reads Playwright's statuses (``passed``, ``failed``, ``skipped``…),
    so pytest's outcomes are mapped onto them:

    - any phase that FAILED fails the test, a teardown after a passing call
      included; a strict xpass is a failed call, so it lands here too;
    - a call that passed passes, a non-strict xpass included (pytest exits 0
      for it);
    - an xfail (a skipped call carrying ``wasxfail``) is the suite behaving
      as declared, so it passes;
    - a skip at setup (a skip marker) or in the body (``pytest.skip()``) skips;
    - nothing recorded at all is a failure, never an inferred pass.
    """
    failed = [p for p in phases if p["outcome"] == "failed"]
    if failed:
        first = failed[0]
        return {
            "status": "failed",
            "error": first.get("message") or f"{first['when']} failed",
            "errorStack": first.get("longrepr"),
        }
    calls = [p for p in phases if p["when"] == "call"]
    if any(p["outcome"] == "passed" for p in calls):
        return {"status": "passed"}
    if any(p["outcome"] == "skipped" and p.get("wasxfail") for p in calls):
        return {"status": "passed"}
    if any(p["outcome"] == "skipped" for p in phases):
        return {"status": "skipped"}
    return {"status": "failed", "error": "pytest recorded no result for this test"}


def attempts(phases: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    """The phases split into attempts, each starting at its setup.

    pytest-rerunfailures reports a phase of an attempt it will retry as
    ``rerun``. Version 16 wraps each attempt in its own logstart/logfinish; a
    wrapper around the whole retry loop would hand all of them to one
    logfinish. Splitting here reads both the same way.
    """
    split: List[List[Dict[str, Any]]] = []
    for phase in phases:
        if not split or (phase["when"] == "setup" and split[-1]):
            split.append([])
        split[-1].append(phase)
    return split


def _crash_message(report: Any) -> Optional[str]:
    crash = getattr(getattr(report, "longrepr", None), "reprcrash", None)
    message = getattr(crash, "message", None)
    return message if isinstance(message, str) and message else None


class _Streamer:
    def __init__(self, plan_path: str, results_out: Optional[str]) -> None:
        with open(plan_path, encoding="utf-8") as handle:
            plan = json.load(handle)
        self.peeps_url: str = plan["peepsUrl"]
        self.runs: Dict[str, Dict[str, Any]] = plan["runs"]
        self.results_out = results_out
        self.started: set = set()
        self.queues: Dict[str, List[Dict[str, Any]]] = {}
        self.phases: Dict[str, List[Dict[str, Any]]] = {}
        self.output_dirs: Dict[str, str] = {}
        self.statuses: Dict[str, str] = {}
        # One delivery thread, in order; drained at session finish.
        self.outbox: "queue.Queue[Any]" = queue.Queue()
        threading.Thread(
            target=self._deliver_forever, name="peeps-events", daemon=True
        ).start()
        print(
            f"[peeps] reporting {len(self.runs)} planned run(s) to {self.peeps_url}",
            flush=True,
        )

    # -- pytest hooks -------------------------------------------------------

    def pytest_runtest_logstart(self, nodeid: str, location: Any) -> None:
        entry = self.runs.get(nodeid)
        self.phases[nodeid] = []
        if entry is None:
            return
        now = _now()
        run_id = entry["runId"]
        if run_id not in self.started:
            self.started.add(run_id)
            self._enqueue(run_id, {"type": "run_start", "timestamp": now})
        self._enqueue(
            run_id,
            {"type": "test_start", "timestamp": now, "testName": _test_name(nodeid)},
        )

    def pytest_runtest_logreport(self, report: Any) -> None:
        for name, value in getattr(report, "user_properties", None) or []:
            if name == OUTPUT_DIR_PROPERTY and isinstance(value, str):
                self.output_dirs[report.nodeid] = value
        phases = self.phases.setdefault(report.nodeid, [])
        phases.append(
            {
                "when": report.when,
                "outcome": report.outcome,
                "wasxfail": hasattr(report, "wasxfail"),
                "duration": getattr(report, "duration", 0) or 0,
                "message": _crash_message(report),
                "longrepr": (
                    report.longreprtext if report.outcome in ("failed", "rerun") else None
                ),
            }
        )

    def pytest_runtest_logfinish(self, nodeid: str, location: Any) -> None:
        entry = self.runs.get(nodeid)
        # A logfinish with no reports at all (the test never reached setup)
        # still owes the run its end.
        for phases in attempts(self.phases.pop(nodeid, [])) or [[]]:
            rerun = next((p for p in phases if p["outcome"] == "rerun"), None)
            retried = rerun is not None
            # A retried attempt failed, as the Playwright reporter sends a
            # failed attempt Playwright will retry; only the final attempt
            # closes the run.
            settled = (
                {
                    "status": "failed",
                    "error": rerun.get("message") or "failed; retried",
                    "errorStack": rerun.get("longrepr"),
                }
                if rerun is not None
                else settle(phases)
            )
            self.statuses[nodeid] = settled["status"]
            if entry is None:
                if not retried:
                    print(
                        f"[peeps] not planned, not reported: {nodeid} ({settled['status']})",
                        flush=True,
                    )
                continue
            event: Dict[str, Any] = {
                "type": "test_end",
                "timestamp": _now(),
                "testName": _test_name(nodeid),
                "status": settled["status"],
                "duration": int(round(sum(p["duration"] for p in phases) * 1000)),
            }
            if settled.get("error"):
                event["error"] = settled["error"][:4000]
            if settled.get("errorStack"):
                event["errorStack"] = settled["errorStack"][:8000]
            self._enqueue(entry["runId"], event)
            if not retried:
                self._enqueue(entry["runId"], {"type": "run_end", "timestamp": _now()})
                self._flush(entry)

    def pytest_sessionfinish(self, session: Any) -> None:
        # A run interrupted mid-test still delivers what it queued.
        for entry in self.runs.values():
            if self.queues.get(entry["runId"]):
                self._flush(entry)
        # Every event handed off is delivered (or given up on) before pytest
        # exits and takes the daemon thread with it.
        self.outbox.join()
        if self.results_out:
            _write_json(
                self.results_out,
                {"outputDirs": self.output_dirs, "statuses": self.statuses},
            )

    # -- delivery -----------------------------------------------------------

    def _enqueue(self, run_id: str, event: Dict[str, Any]) -> None:
        self.queues.setdefault(run_id, []).append(event)

    def _flush(self, entry: Dict[str, Any]) -> None:
        """Hand this run's queued events to the delivery thread.

        Delivery is off the pytest hook: a slow or unreachable Peeps must not
        hold the next test (or, under xdist, the controller) for its retries.
        """
        run_id = entry["runId"]
        events = self.queues.get(run_id) or []
        if not events:
            return
        self.queues[run_id] = []
        self.outbox.put((entry, events))

    def _deliver_forever(self) -> None:
        while True:
            entry, events = self.outbox.get()
            try:
                self._post(entry, events)
            finally:
                self.outbox.task_done()

    def _post(self, entry: Dict[str, Any], events: List[Dict[str, Any]]) -> None:
        run_id = entry["runId"]
        credential = entry["credential"]
        request = urllib.request.Request(
            f"{self.peeps_url}/api/v1/runs/{run_id}/events",
            data=json.dumps({"events": events}).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer v1.{credential['exp']}.{credential['sig']}",
                "User-Agent": USER_AGENT,
            },
        )
        # The Playwright reporter's retry rule: a 4xx other than 408/429 is
        # permanent, anything else is tried three times.
        for attempt in range(3):
            try:
                with urllib.request.urlopen(request, timeout=10):
                    return
            except urllib.error.HTTPError as error:
                if error.code < 500 and error.code not in (408, 429):
                    body = error.read().decode("utf-8", "replace")[:500]
                    print(
                        f"[peeps] events for {run_id} rejected: {error.code} {body}",
                        flush=True,
                    )
                    return
                if attempt == 2:
                    print(f"[peeps] events for {run_id} failed: {error}", flush=True)
            except Exception as error:  # network, timeout
                if attempt == 2:
                    print(f"[peeps] events for {run_id} failed: {error}", flush=True)
            if attempt < 2:
                time.sleep(attempt + 1)


def _now() -> int:
    return int(time.time() * 1000)


def _test_name(nodeid: str) -> str:
    """The last `::` segment, as the Playwright reporter sends a test's title."""
    # The parameter id is customer data and may hold `::`; a directory may be
    # named `[x]`. So the id starts at the first `[` after the first `::`.
    open_at = nodeid.find("[", max(0, nodeid.find("::")))
    if open_at == -1 or not nodeid.endswith("]"):
        return nodeid.split("::")[-1]
    return nodeid[:open_at].split("::")[-1] + nodeid[open_at:]


class _OutputDirRecorder:
    """Carries pytest-playwright's per-test artifact directory on the test's
    reports, where the streamer reads it. Registered in every process: under
    pytest-xdist the fixtures live in the workers, and only the reports reach
    the controller."""

    @pytest.hookimpl(hookwrapper=True, trylast=True)
    def pytest_runtest_setup(self, item: Any):
        yield
        # Read after setup, while the fixture values still exist.
        funcargs = getattr(item, "funcargs", None) or {}
        output = funcargs.get("output_path")
        if isinstance(output, str):
            item.user_properties.append((OUTPUT_DIR_PROPERTY, output))


def _is_xdist_worker(config: Any) -> bool:
    return hasattr(config, "workerinput")


def pytest_configure(config: Any) -> None:
    # Under pytest-xdist, only the controller reports: workers' runtest log
    # hooks are forwarded to it, so a streamer in each worker as well would
    # post every event twice.
    worker = _is_xdist_worker(config)
    collect_out = os.environ.get("PEEPS_COLLECT_OUT")
    if collect_out and not worker:
        config.pluginmanager.register(_Collector(collect_out), "peeps-collector")
    plan = os.environ.get("PEEPS_PLAN_FILE")
    if plan:
        config.pluginmanager.register(_OutputDirRecorder(), "peeps-output-dirs")
        if not worker:
            config.pluginmanager.register(
                _Streamer(plan, os.environ.get("PEEPS_RESULTS_OUT")), "peeps-streamer"
            )
