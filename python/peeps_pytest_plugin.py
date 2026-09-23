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
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

import pytest

USER_AGENT = "peeps-action/0.1"


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
        print(
            f"[peeps] reporting {len(self.runs)} planned run(s) to {self.peeps_url}",
            flush=True,
        )

    # -- pytest hooks -------------------------------------------------------

    @pytest.hookimpl(hookwrapper=True, trylast=True)
    def pytest_runtest_setup(self, item: Any):
        yield
        # pytest-playwright's per-test artifact directory, when this test uses
        # it; read after setup, while the fixture values still exist.
        funcargs = getattr(item, "funcargs", None) or {}
        output = funcargs.get("output_path")
        if isinstance(output, str):
            self.output_dirs[item.nodeid] = output

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
        phases = self.phases.setdefault(report.nodeid, [])
        phases.append(
            {
                "when": report.when,
                "outcome": report.outcome,
                "wasxfail": hasattr(report, "wasxfail"),
                "duration": getattr(report, "duration", 0) or 0,
                "message": _crash_message(report),
                "longrepr": report.longreprtext if report.failed else None,
            }
        )

    def pytest_runtest_logfinish(self, nodeid: str, location: Any) -> None:
        phases = self.phases.pop(nodeid, [])
        # pytest-rerunfailures reports an attempt it will retry as `rerun`:
        # that attempt is not the result, and the next one follows.
        retried = any(p["outcome"] == "rerun" for p in phases)
        settled = (
            {"status": "failed", "error": "failed; retrying"}
            if retried
            else settle(phases)
        )
        self.statuses[nodeid] = settled["status"]
        entry = self.runs.get(nodeid)
        if entry is None:
            print(
                f"[peeps] not planned, not reported: {nodeid} ({settled['status']})",
                flush=True,
            )
            return
        run_id = entry["runId"]
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
        self._enqueue(run_id, event)
        if not retried:
            self._enqueue(run_id, {"type": "run_end", "timestamp": _now()})
            self._flush(entry)

    def pytest_sessionfinish(self, session: Any) -> None:
        # A run interrupted mid-test still delivers what it queued.
        for entry in self.runs.values():
            if self.queues.get(entry["runId"]):
                self._flush(entry)
        if self.results_out:
            _write_json(
                self.results_out,
                {"outputDirs": self.output_dirs, "statuses": self.statuses},
            )

    # -- delivery -----------------------------------------------------------

    def _enqueue(self, run_id: str, event: Dict[str, Any]) -> None:
        self.queues.setdefault(run_id, []).append(event)

    def _flush(self, entry: Dict[str, Any]) -> None:
        run_id = entry["runId"]
        events = self.queues.get(run_id) or []
        if not events:
            return
        self.queues[run_id] = []
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


def pytest_configure(config: Any) -> None:
    collect_out = os.environ.get("PEEPS_COLLECT_OUT")
    if collect_out:
        config.pluginmanager.register(_Collector(collect_out), "peeps-collector")
    plan = os.environ.get("PEEPS_PLAN_FILE")
    if plan:
        config.pluginmanager.register(
            _Streamer(plan, os.environ.get("PEEPS_RESULTS_OUT")), "peeps-streamer"
        )
