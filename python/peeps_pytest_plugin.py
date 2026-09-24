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

Evidence on ``test_end``
    The final attempt's ``test_end`` also carries what a non-browser test
    leaves behind, each field optional and absent when empty (see
    ``evidence_fields`` for the exact shape and caps; README "What a pytest
    test reports" documents it for the server):

    - ``skipReason``: the reason of a ``pytest.skip()`` / skip / skipif;
    - ``failure``: the failing phase, exception type and message, and
      pytest's rendered traceback, assertion rewrite included;
    - ``properties``: ``record_property`` name/value pairs (measurements);
    - ``output``: captured stdout / stderr / log sections of a failed test;
    - ``attachments``: files the test saved in ``peeps_artifacts_dir`` or
      named with ``record_property("peeps_attachment", path)``, staged under
      ``PEEPS_ARTIFACTS_DIR/upload`` for the action to upload as
      ``data/<runId>-evidence-<name>``.

Standard library only: this runs inside the customer's Python, whatever it has.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import queue
import re
import shutil
import stat
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

import pytest

USER_AGENT = "peeps-action/0.1"

#: How long the session's end waits for undelivered events.
DELIVERY_DRAIN_SECONDS = 60

#: The user property a test's pytest-playwright output directory rides on.
OUTPUT_DIR_PROPERTY = "peeps_output_dir"

#: ``record_property(ATTACHMENT_PROPERTY, path)`` attaches a file to the test.
ATTACHMENT_PROPERTY = "peeps_attachment"

#: Our own user properties: never reported as measurements.
INTERNAL_PROPERTIES = {OUTPUT_DIR_PROPERTY, ATTACHMENT_PROPERTY}

# Evidence caps. An events request is capped at 1 MB by Peeps and a run's
# events travel together, so every text field is bounded.
MAX_MESSAGE_CHARS = 4000
MAX_TRACEBACK_HEAD_CHARS = 2000
MAX_TRACEBACK_TAIL_CHARS = 10000
MAX_SKIP_REASON_CHARS = 1000
MAX_PROPERTIES = 50
MAX_PROPERTY_NAME_CHARS = 200
MAX_PROPERTY_VALUE_CHARS = 1000
MAX_OUTPUT_SECTIONS = 10
MAX_OUTPUT_SECTION_CHARS = 8000
MAX_ATTACHMENTS_PER_TEST = 20
MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
MAX_ATTACHMENT_BYTES_PER_TEST = 100 * 1024 * 1024
MAX_ATTACHMENTS_PER_SESSION = 1000
MAX_ATTACHMENT_BYTES_PER_SESSION = 1024 * 1024 * 1024
MAX_OMITTED_LISTED = 20
#: The serialized evidence of one test_end, as ``_post`` encodes it (ASCII
#: escapes included). The caps above bound characters, not bytes: a
#: non-ASCII property or output can be 12 bytes a character once escaped.
MAX_EVIDENCE_BYTES = 256 * 1024

#: The extensions Peeps accepts under a batch's ``data/`` (mirrors
#: ``DATA_ATTACHMENT_EXTENSIONS`` in Peeps' artifacts route). Any other file
#: is uploaded with ``.dat`` appended, so it is stored rather than refused.
DATA_EXTENSIONS = {
    "dat", "png", "jpg", "jpeg", "gif", "webp", "webm", "mp4", "zip",
    "md", "txt", "log", "json", "csv", "har", "pdf",
}  # fmt: skip

#: Path segments never uploaded, as the action's agent tools refuse them.
_DENY_SEGMENT = re.compile(r"^(\.git|node_modules|\.env(\..*)?)$")


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


def _item_record(item: Any) -> Dict[str, Any]:
    return {
        "nodeId": item.nodeid,
        "browser": _browser_of(item),
        "line": _line_of(item),
        "markers": [marker.name for marker in item.iter_markers()],
    }


class _Collector:
    def __init__(self, out: str) -> None:
        self.out = out
        self.errors: List[Dict[str, str]] = []
        self.deselected: List[Dict[str, Any]] = []

    @pytest.hookimpl(trylast=True)
    def pytest_deselected(self, items: Any) -> None:
        # Tests `-m`/`-k` (often from addopts) left out of this session. They
        # are still tests in the repository, so the inventory lists them;
        # only a run leaves them out.
        self.deselected.extend(_item_record(item) for item in items)

    @pytest.hookimpl(trylast=True)
    def pytest_collectreport(self, report: Any) -> None:
        if report.failed:
            self.errors.append(
                {"nodeId": report.nodeid, "message": report.longreprtext[-2000:]}
            )

    @pytest.hookimpl(trylast=True)
    def pytest_collection_finish(self, session: Any) -> None:
        config = session.config
        items = [_item_record(item) for item in session.items]
        _write_json(
            self.out,
            {
                "rootDir": str(config.rootpath),
                "iniPath": str(config.inipath) if config.inipath else None,
                "playwright": config.pluginmanager.hasplugin("playwright"),
                "items": items,
                "deselected": self.deselected,
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


# ---------------------------------------------------------------------------
# Evidence: what a test leaves behind, for its final test_end
# ---------------------------------------------------------------------------


def _trim_middle(text: str, head: int, tail: int) -> str:
    """Keep both ends: a traceback's cause is at its end, its entry at the top."""
    if len(text) <= head + tail:
        return text
    cut = len(text) - head - tail
    return f"{text[:head]}\n... {cut} characters trimmed ...\n{text[-tail:]}"


def _trim_tail(text: str, keep: int) -> str:
    if len(text) <= keep:
        return text
    return f"... {len(text) - keep} characters trimmed ...\n{text[-keep:]}"


def skip_reason(longrepr: Any) -> Optional[str]:
    """The reason of a skip report: ``(path, line, "Skipped: <reason>")``, a
    list once it has crossed from an xdist worker."""
    if isinstance(longrepr, (tuple, list)) and len(longrepr) == 3:
        reason = longrepr[2]
    else:
        reason = getattr(longrepr, "reprcrash", None) and longrepr.reprcrash.message
    if not isinstance(reason, str) or not reason:
        return None
    if reason.startswith("Skipped: "):
        reason = reason[len("Skipped: ") :]
    return reason[:MAX_SKIP_REASON_CHARS]


def json_safe(value: Any) -> Any:
    """A measurement as JSON Peeps can store: a string, finite number, bool or
    null as is (a numpy scalar through ``.item()``), anything else as text."""
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value if abs(value) <= 2**53 else str(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, str):
        return value[:MAX_PROPERTY_VALUE_CHARS]
    item = getattr(value, "item", None)
    if callable(item) and type(value).__module__.startswith("numpy"):
        try:
            scalar = item()
        except Exception:
            scalar = value
        if scalar is not value and not hasattr(scalar, "item"):
            return json_safe(scalar)
    try:
        text = json.dumps(value, allow_nan=False, default=str)
    except Exception:
        try:
            text = str(value)
        except Exception:
            text = f"<unprintable {type(value).__name__}>"
    return text[:MAX_PROPERTY_VALUE_CHARS]


def _exception_type(excinfo: Any) -> str:
    kind = excinfo.type
    module = getattr(kind, "__module__", "builtins")
    name = getattr(kind, "__qualname__", None) or excinfo.typename
    return name if module == "builtins" else f"{module}.{name}"


def artifacts_key(nodeid: str) -> str:
    """A test's directory under ``PEEPS_ARTIFACTS_DIR/tests``: stable across
    processes, so an xdist worker and the controller name the same one."""
    return hashlib.sha1(nodeid.encode("utf-8")).hexdigest()[:16]


def upload_name(run_id: str, name: str, taken: set) -> str:
    """The file name one attachment is staged and uploaded under (the batch
    path is ``data/`` + this): the run, ``-evidence-``, then the file's own
    name flattened; an extension Peeps' ``data/`` refuses gets ``.dat``
    appended; a name another attachment of the test took gets a counter."""
    flat = re.sub(r"[^A-Za-z0-9._-]", "_", name.replace("/", "-")).lstrip(".") or "file"
    if len(flat) > 120:
        ext = os.path.splitext(flat)[1][:12]
        flat = hashlib.sha1(name.encode("utf-8")).hexdigest() + ext
    ext = os.path.splitext(flat)[1][1:].lower()
    if ext not in DATA_EXTENSIONS:
        flat = f"{flat}.dat"
    candidate = f"{run_id}-evidence-{flat}"
    counter = 2
    while candidate in taken:
        candidate = f"{run_id}-evidence-{counter}-{flat}"
        counter += 1
    taken.add(candidate)
    return candidate


def _inside(path: str, roots: List[str]) -> Optional[str]:
    """The root ``path`` (real) lies under, with no refused segment on the way."""
    for root in roots:
        rel = os.path.relpath(path, root)
        if rel == os.curdir or rel.startswith(os.pardir) or os.path.isabs(rel):
            continue
        if any(_DENY_SEGMENT.match(segment) for segment in rel.split(os.sep)):
            return None
        return root
    return None


def _walk_files(directory: str) -> Iterator[Tuple[str, str]]:
    """Regular files under ``directory``, sorted, symlinks not followed."""
    for current, dirs, files in os.walk(directory):
        dirs.sort()
        for name in sorted(files):
            abs_path = os.path.join(current, name)
            yield abs_path, os.path.relpath(abs_path, directory).replace(os.sep, "/")


def _allowed_roots(config: Any) -> List[str]:
    """Where an attached file may come from: the repository and pytest's
    temporary directory (``tmp_path`` lives there; under xdist, this worker's)."""
    roots = []
    workspace = os.environ.get("PEEPS_WORKSPACE")
    if workspace:
        roots.append(os.path.realpath(workspace))
    try:
        factory = getattr(config, "_tmp_path_factory", None)
        if factory is not None:
            roots.append(os.path.realpath(str(factory.getbasetemp())))
    except Exception:
        pass
    return roots


def snapshot_attachments(item: Any, values: List[Any], base: str) -> List[Dict[str, Any]]:
    """Copy the files a test attached into the artifacts directory, where the
    test runs and before its fixtures are torn down: ``tmp_path`` may be
    deleted at teardown (``tmp_path_retention_policy``), and a later test
    may overwrite the same path. Each entry is ``{name, file}`` for a copy
    or ``{name, reason}`` for a refusal; the jail is applied here, to the
    path the test named."""
    entries: List[Dict[str, Any]] = []
    key = artifacts_key(item.nodeid)
    snapshots = os.path.join(base, "attached", key)
    own = os.path.realpath(base)
    invocation = str(item.config.invocation_params.dir)
    roots: Optional[List[str]] = None
    for value in values:
        index = item._peeps_attached_count
        item._peeps_attached_count += 1
        raw = os.fspath(value) if isinstance(value, (str, os.PathLike)) else None
        if not raw:
            entries.append({"name": str(value), "reason": "not a path"})
            continue
        name = os.path.basename(raw) or "file"
        real = os.path.realpath(os.path.join(invocation, raw))
        if _inside(real, [own]) is not None:
            continue  # in peeps_artifacts_dir already: uploaded from there
        roots = roots if roots is not None else _allowed_roots(item.config)
        if _inside(real, roots) is None:
            entries.append({"name": name, "reason": "outside the workspace"})
            continue
        try:
            info = os.stat(real)
        except OSError:
            entries.append({"name": name, "reason": "missing"})
            continue
        if not stat.S_ISREG(info.st_mode):
            entries.append({"name": name, "reason": "not a regular file"})
            continue
        if info.st_size > MAX_ATTACHMENT_BYTES:
            entries.append({"name": name, "reason": f"larger than {MAX_ATTACHMENT_BYTES} bytes"})
            continue
        if index >= MAX_ATTACHMENTS_PER_TEST:
            entries.append({"name": name, "reason": f"more than {MAX_ATTACHMENTS_PER_TEST} files"})
            continue
        # The per-test budget before copying, so a suite that attaches too
        # much never fills the runner's disk with copies nobody uploads.
        if item._peeps_attached_bytes + info.st_size > MAX_ATTACHMENT_BYTES_PER_TEST:
            entries.append(
                {"name": name, "reason": f"test total over {MAX_ATTACHMENT_BYTES_PER_TEST} bytes"}
            )
            continue
        try:
            os.makedirs(snapshots, exist_ok=True)
            copy = os.path.join(snapshots, str(index))
            shutil.copyfile(real, copy)
        except OSError as error:
            entries.append({"name": name, "reason": f"unreadable: {error.strerror}"})
            continue
        item._peeps_attached_bytes += info.st_size
        entries.append({"name": name, "file": copy})
    return entries


class _AttachmentStager:
    """Stages a test's files for upload, in the controller, within the
    per-test and per-session caps: what it saved in ``peeps_artifacts_dir``
    and the copies ``snapshot_attachments`` made of what it attached. Both
    live in the action's own directory; nothing else is read."""

    def __init__(self, base: str) -> None:
        self.base = os.path.realpath(base)
        self.upload_dir = os.path.join(self.base, "upload")
        os.makedirs(self.upload_dir, exist_ok=True)
        self.session_files = 0
        self.session_bytes = 0

    def stage(
        self, nodeid: str, run_id: str, attached: List[Dict[str, Any]]
    ) -> Tuple[List[Dict[str, Any]], List[Dict[str, str]]]:
        """(attachments, omitted): what was staged and what was not, and why."""
        staged: List[Dict[str, Any]] = []
        omitted: List[Dict[str, str]] = []
        candidates: List[Tuple[str, str]] = []  # (source, name)
        key = artifacts_key(nodeid)
        test_dir = os.path.join(self.base, "tests", key)
        if os.path.isdir(test_dir) and not os.path.islink(test_dir):
            for abs_path, rel in _walk_files(test_dir):
                # A symlink is not followed out, and a copied .git /
                # node_modules / .env is refused here too.
                if os.path.islink(abs_path):
                    omitted.append({"name": rel, "reason": "symlink"})
                elif any(_DENY_SEGMENT.match(segment) for segment in rel.split("/")):
                    omitted.append({"name": rel, "reason": "refused name"})
                else:
                    candidates.append((abs_path, rel))
        snapshots = os.path.join(self.base, "attached", key)
        for entry in attached if isinstance(attached, list) else []:
            name = str(entry.get("name") or "file")
            source = entry.get("file")
            if not isinstance(source, str):
                omitted.append({"name": name, "reason": str(entry.get("reason") or "not uploaded")})
            elif os.path.realpath(os.path.dirname(source)) != snapshots or os.path.islink(source):
                omitted.append({"name": name, "reason": "not a snapshot"})
            else:
                candidates.append((source, name))

        taken: set = set()
        test_bytes = 0
        for source, name in candidates:
            try:
                info = os.lstat(source)
            except OSError:
                omitted.append({"name": name, "reason": "missing"})
                continue
            if not stat.S_ISREG(info.st_mode):
                omitted.append({"name": name, "reason": "not a regular file"})
                continue
            reason = None
            if len(staged) >= MAX_ATTACHMENTS_PER_TEST:
                reason = f"more than {MAX_ATTACHMENTS_PER_TEST} files"
            elif info.st_size > MAX_ATTACHMENT_BYTES:
                reason = f"larger than {MAX_ATTACHMENT_BYTES} bytes"
            elif test_bytes + info.st_size > MAX_ATTACHMENT_BYTES_PER_TEST:
                reason = f"test total over {MAX_ATTACHMENT_BYTES_PER_TEST} bytes"
            elif self.session_files >= MAX_ATTACHMENTS_PER_SESSION:
                reason = f"session over {MAX_ATTACHMENTS_PER_SESSION} files"
            elif self.session_bytes + info.st_size > MAX_ATTACHMENT_BYTES_PER_SESSION:
                reason = f"session total over {MAX_ATTACHMENT_BYTES_PER_SESSION} bytes"
            if reason:
                omitted.append({"name": name, "reason": reason})
                continue
            staged_name = upload_name(run_id, name, taken)
            try:
                # Moved out of the per-test directories, which are ours: the
                # next attempt or test starts from empty ones anyway.
                shutil.move(source, os.path.join(self.upload_dir, staged_name))
            except OSError as error:
                omitted.append({"name": name, "reason": f"unreadable: {error.strerror}"})
                continue
            test_bytes += info.st_size
            self.session_files += 1
            self.session_bytes += info.st_size
            staged.append({"name": name, "path": f"data/{staged_name}", "size": info.st_size})
        for entry in omitted:
            print(f"[peeps] attachment of {nodeid} not uploaded: {entry['name']} ({entry['reason']})", flush=True)
        omitted = omitted[:MAX_OMITTED_LISTED]
        for entry in staged + omitted:
            entry["name"] = entry["name"][:MAX_PROPERTY_NAME_CHARS]
        return staged, omitted

    def discard(self, nodeid: str) -> None:
        """Remove what is left of a finished test's files: whatever was not
        staged (over a cap, refused, or a test Peeps did not plan)."""
        key = artifacts_key(nodeid)
        for directory in (os.path.join(self.base, "tests", key), os.path.join(self.base, "attached", key)):
            if os.path.islink(directory):
                os.unlink(directory)
            elif os.path.lexists(directory):
                shutil.rmtree(directory, ignore_errors=True)


def evidence_fields(
    phases: List[Dict[str, Any]], status: str
) -> Tuple[Dict[str, Any], List[Any]]:
    """The evidence fields of one attempt's ``test_end``, and the snapshots
    of what the test attached (``peeps_attachment``) for the stager.

    Every field is optional and left out when empty::

        skipReason: str                  # status "skipped"
        failure: {                       # status "failed", from the first failed phase
            phase: "setup" | "call" | "teardown",
            exceptionType: str | None,   # "AssertionError", "mypkg.CameraError"
            message: str,                # str(exception), assertion rewrite included
            traceback: str,              # pytest's longreprtext, middle trimmed
        }
        properties: [{name: str, value: str | number | bool | None}]
        propertiesOmitted: int           # over MAX_PROPERTIES
        output: [{name: str, text: str}] # status "failed": "Captured stdout call"...
    """
    fields: Dict[str, Any] = {}
    last = phases[-1] if phases else {}
    if status == "skipped":
        reason = next((p["skipReason"] for p in phases if p.get("skipReason")), None)
        if reason:
            fields["skipReason"] = reason
    if status == "failed":
        failed = next((p for p in phases if p["outcome"] in ("failed", "rerun")), None)
        if failed is not None:
            exception = failed.get("exception") or {}
            fields["failure"] = {
                "phase": failed["when"],
                "exceptionType": exception.get("type"),
                "message": (exception.get("message") or failed.get("message") or "")[
                    :MAX_MESSAGE_CHARS
                ],
                "traceback": _trim_middle(
                    failed.get("longrepr") or "",
                    MAX_TRACEBACK_HEAD_CHARS,
                    MAX_TRACEBACK_TAIL_CHARS,
                ),
            }
        sections = [
            {"name": str(title)[:200], "text": _trim_tail(str(text), MAX_OUTPUT_SECTION_CHARS)}
            for title, text in last.get("sections") or []
            if str(title).startswith("Captured ") and text
        ]
        if sections:
            fields["output"] = sections[-MAX_OUTPUT_SECTIONS:]
    properties: List[Dict[str, Any]] = []
    omitted = 0
    for pair in last.get("properties") or []:
        try:
            name, value = pair
        except (TypeError, ValueError):
            continue
        name = str(name)
        if name in INTERNAL_PROPERTIES:
            continue
        elif len(properties) >= MAX_PROPERTIES:
            omitted += 1
        else:
            properties.append({"name": name[:MAX_PROPERTY_NAME_CHARS], "value": json_safe(value)})
    if properties:
        fields["properties"] = properties
    if omitted:
        fields["propertiesOmitted"] = omitted
    attached = next((p["attached"] for p in reversed(phases) if p.get("attached")), [])
    return fields, attached


def _encoded_size(value: Any) -> int:
    return len(json.dumps(value).encode("utf-8"))


def bound_evidence(fields: Dict[str, Any], budget: int = MAX_EVIDENCE_BYTES) -> Dict[str, Any]:
    """``fields`` within ``budget`` bytes as ``_post`` sends them, so evidence
    can never push a run's events request past Peeps' 1 MB cap (a 413 is
    permanent, and would lose the result with the evidence). Gives up the
    least useful first: output, then measurements from the end, then most of
    the traceback; marks the event ``evidenceTrimmed``."""
    if _encoded_size(fields) <= budget:
        return fields
    fields["evidenceTrimmed"] = True
    output = fields.get("output")
    if output:
        for section in output:
            section["text"] = _trim_tail(section["text"], 1000)
        if _encoded_size(fields) > budget:
            del fields["output"]
    properties = fields.get("properties")
    while properties and _encoded_size(fields) > budget:
        properties.pop()
        fields["propertiesOmitted"] = fields.get("propertiesOmitted", 0) + 1
    if properties == []:
        del fields["properties"]
    failure = fields.get("failure")
    if failure and _encoded_size(fields) > budget:
        failure["message"] = failure["message"][:500]
        failure["traceback"] = _trim_middle(failure["traceback"], 500, 2000)
    if _encoded_size(fields) > budget:
        # Only the file names are left, and they are bounded; never expected.
        return {"evidenceTrimmed": True}
    return fields


class _Streamer:
    def __init__(
        self,
        plan_path: str,
        results_out: Optional[str],
        stager: Optional[_AttachmentStager] = None,
    ) -> None:
        with open(plan_path, encoding="utf-8") as handle:
            plan = json.load(handle)
        self.peeps_url: str = plan["peepsUrl"]
        self.runs: Dict[str, Dict[str, Any]] = plan["runs"]
        self.results_out = results_out
        self.stager = stager
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
        failed = report.outcome in ("failed", "rerun")
        evidence = getattr(report, EVIDENCE_ATTRIBUTE, None) or {}
        properties_kept = evidence.get("propertiesKept", 0)
        properties_from = evidence.get("propertiesFrom", 0)
        sections_from = evidence.get("sectionsFrom", 0)
        user_properties = list(getattr(report, "user_properties", None) or [])
        phases.append(
            {
                "when": report.when,
                "outcome": report.outcome,
                "wasxfail": hasattr(report, "wasxfail"),
                "duration": getattr(report, "duration", 0) or 0,
                "message": _crash_message(report),
                "longrepr": report.longreprtext if failed else None,
                # The rest is evidence for the final attempt's test_end.
                "exception": evidence.get("exception"),
                "skipReason": (
                    skip_reason(report.longrepr) if report.outcome == "skipped" else None
                ),
                # Set before the first attempt (at collection), then this
                # attempt's own: never an earlier attempt's.
                "properties": user_properties[:properties_kept]
                + user_properties[properties_from:],
                "attached": evidence.get("attached"),
                "sections": list(getattr(report, "sections", None) or [])[sections_from:],
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
            if not retried:
                # Evidence of the final attempt only: a retried attempt's
                # test_end stays as it was, so nothing is reported twice.
                event.update(self._evidence(nodeid, entry, phases, settled["status"]))
            self._enqueue(entry["runId"], event)
            if not retried:
                self._enqueue(entry["runId"], {"type": "run_end", "timestamp": _now()})
                self._flush(entry)
        if self.stager is not None:
            self.stager.discard(nodeid)

    def _evidence(
        self, nodeid: str, entry: Dict[str, Any], phases: List[Dict[str, Any]], status: str
    ) -> Dict[str, Any]:
        # Evidence is a bonus on top of the result: a bug here must never cost
        # the test_end itself.
        try:
            fields, attached = evidence_fields(phases, status)
            if self.stager is not None:
                staged, omitted = self.stager.stage(nodeid, entry["runId"], attached)
                if staged:
                    fields["attachments"] = staged
                if omitted:
                    fields["attachmentsOmitted"] = omitted
            return bound_evidence(fields)
        except Exception as error:  # pragma: no cover - defensive
            print(f"[peeps] evidence for {nodeid} not reported: {error!r}", flush=True)
            return {}

    def pytest_sessionfinish(self, session: Any) -> None:
        # A run interrupted mid-test still delivers what it queued.
        for entry in self.runs.values():
            if self.queues.get(entry["runId"]):
                self._flush(entry)
        # Every event handed off is delivered, or given up on, before pytest
        # exits and takes the daemon thread with it — within a bound, so a
        # Peeps outage costs the job at most that long, not a retry cycle per
        # test.
        deadline = time.monotonic() + DELIVERY_DRAIN_SECONDS
        while self.outbox.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.1)
        if self.outbox.unfinished_tasks:
            print(
                f"[peeps] gave up delivering {self.outbox.unfinished_tasks} event batch(es) "
                f"after {DELIVERY_DRAIN_SECONDS}s",
                flush=True,
            )
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


#: The report attribute the recorder below leaves for the streamer. A plain
#: dict of builtins, so it survives pytest-xdist's report serialization.
EVIDENCE_ATTRIBUTE = "peeps_evidence"


class _EvidenceRecorder:
    """Marks each report with where this attempt's user properties and
    captured sections start, with the exception a failed phase raised, and
    with the snapshots of the files the attempt attached.

    pytest-rerunfailures reruns the same item, and ``item.user_properties`` and
    its captured sections keep growing across attempts; the offsets taken at
    each attempt's setup let the streamer read the final attempt's own, with
    no duplicates (properties set before the first attempt, at collection,
    belong to every attempt). Runs where the test runs, an xdist worker
    included: the exception object and the test's files are there, and only
    the reports reach the controller."""

    @pytest.hookimpl(hookwrapper=True, tryfirst=True)
    def pytest_runtest_setup(self, item: Any):
        offsets = getattr(item, "_peeps_attempt_offsets", None)
        properties = len(item.user_properties)
        item._peeps_attempt_offsets = (
            offsets[0] if offsets else properties,
            properties,
            len(getattr(item, "_report_sections", None) or []),
        )
        item._peeps_attached = []
        item._peeps_attached_count = 0
        item._peeps_attached_bytes = 0
        # Each attempt starts with empty artifacts directories, before any
        # fixture runs: an attempt that fails in setup, before it ever asks
        # for `peeps_artifacts_dir`, must not report the last attempt's files.
        base = os.environ.get("PEEPS_ARTIFACTS_DIR")
        if base:
            key = artifacts_key(item.nodeid)
            for directory in (os.path.join(base, "tests", key), os.path.join(base, "attached", key)):
                if os.path.islink(directory):
                    os.unlink(directory)
                elif os.path.lexists(directory):
                    shutil.rmtree(directory, ignore_errors=True)
        yield

    def _snapshot(self, item: Any) -> None:
        base = os.environ.get("PEEPS_ARTIFACTS_DIR")
        offsets = getattr(item, "_peeps_attempt_offsets", None)
        if not base or offsets is None:
            return
        values = [
            value
            for name, value in item.user_properties[offsets[1] :]
            if name == ATTACHMENT_PROPERTY
        ][item._peeps_attached_count :]
        if values:
            item._peeps_attached.extend(snapshot_attachments(item, values, base))

    @pytest.hookimpl(hookwrapper=True, tryfirst=True)
    def pytest_runtest_teardown(self, item: Any, nextitem: Any):
        # Before the fixtures' teardown (tmp_path may go with it), and again
        # after it for what a fixture attached while tearing down.
        self._snapshot(item)
        yield
        self._snapshot(item)

    @pytest.hookimpl(hookwrapper=True)
    def pytest_runtest_makereport(self, item: Any, call: Any):
        outcome = yield
        report = outcome.get_result()
        kept, properties_from, sections_from = getattr(
            item, "_peeps_attempt_offsets", (0, 0, 0)
        )
        evidence: Dict[str, Any] = {
            "propertiesKept": kept,
            "propertiesFrom": properties_from,
            "sectionsFrom": sections_from,
        }
        if call.when == "teardown" and getattr(item, "_peeps_attached", None):
            evidence["attached"] = list(item._peeps_attached)
        excinfo = getattr(call, "excinfo", None)
        if report.failed and excinfo is not None:
            try:
                message = str(excinfo.value)
            except Exception:
                message = ""
            evidence["exception"] = {
                "type": _exception_type(excinfo),
                "message": message[:MAX_MESSAGE_CHARS],
            }
        setattr(report, EVIDENCE_ATTRIBUTE, evidence)


@pytest.fixture
def peeps_artifacts_dir(request: Any, tmp_path_factory: Any) -> Path:
    """A directory for this test's files: whatever the test saves here (a
    camera frame, a log) is uploaded to Peeps with the test's result.

    Emptied at the start of each attempt (by ``_EvidenceRecorder``), so a
    retried test reports only its final attempt's files. Outside the action
    (no ``PEEPS_ARTIFACTS_DIR``) it is an ordinary temporary directory and
    nothing is uploaded."""
    base = os.environ.get("PEEPS_ARTIFACTS_DIR")
    if not base:
        return tmp_path_factory.mktemp("peeps-artifacts")
    directory = Path(base) / "tests" / artifacts_key(request.node.nodeid)
    directory.mkdir(parents=True, exist_ok=True)
    return directory


class _Selector:
    """Runs only the planned node ids (``run`` mode): whatever else the
    customer's ``addopts`` names — a ``tests/`` target, say — is deselected,
    not executed. In every process, since xdist workers collect for
    themselves."""

    def __init__(self, plan_path: str) -> None:
        with open(plan_path, encoding="utf-8") as handle:
            self.planned = set(json.load(handle)["runs"])

    @pytest.hookimpl(trylast=True)
    def pytest_collection_modifyitems(self, config: Any, items: List[Any]) -> None:
        keep = [item for item in items if item.nodeid in self.planned]
        dropped = [item for item in items if item.nodeid not in self.planned]
        if dropped:
            config.hook.pytest_deselected(items=dropped)
            items[:] = keep


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
        config.pluginmanager.register(_EvidenceRecorder(), "peeps-evidence")
        if os.environ.get("PEEPS_SELECT_ONLY") == "1":
            config.pluginmanager.register(_Selector(plan), "peeps-selector")
        if not worker:
            artifacts = os.environ.get("PEEPS_ARTIFACTS_DIR")
            stager = _AttachmentStager(artifacts) if artifacts else None
            config.pluginmanager.register(
                _Streamer(plan, os.environ.get("PEEPS_RESULTS_OUT"), stager),
                "peeps-streamer",
            )
