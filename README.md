# peeps-action

Runs [Peeps](https://peepsai.com) inside your CI. Your repository holds the
tests and your runner runs them with your own secrets and your own network
access; Peeps cloud does the reporting, failure analysis, healing and test
generation. Peeps' prompts and models stay in Peeps.

Your repository stores **no Peeps secret**: the job authenticates with GitHub's
OIDC token for that job.

**Before you install this, read [SECURITY.md](SECURITY.md).** It lists exactly
what this action sends to Peeps and what Peeps can do on your runner. Both are
more than people assume, and we would rather you learn it from us than find it
yourself.

```yaml
# .github/workflows/peeps.yml
name: Peeps
on:
  workflow_dispatch:
    inputs:
      mode:      { type: string, required: true }   # inventory | run | agent
      sessionId: { type: string, required: false }
      ref:       { type: string, required: false }
  push:
    branches: [main]          # your default branch: Peeps mirrors only that
  pull_request:
permissions:
  contents: read
  id-token: write             # OIDC → Peeps; no Peeps secret needed
jobs:
  peeps:
    name: "peeps ${{ inputs.mode || 'report' }} ${{ inputs.sessionId || '' }}"
    runs-on: ubuntu-latest
    container: mcr.microsoft.com/playwright:v1.59.1-jammy
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v7
        with: { ref: "${{ inputs.ref || github.ref }}" }
      - run: npm ci
      - uses: Peeps-Labs/peeps-action@v1
        with:
          mode: ${{ inputs.mode }}
          session-id: ${{ inputs.sessionId }}
```

**Python (pytest-playwright) suites** use the same workflow with Python in
place of Node. The action finds pytest by itself when the working directory has
a `pytest.ini`, a `conftest.py` or a `pyproject.toml` with
`[tool.pytest.ini_options]` and no Playwright config; `framework: pytest` says
so outright:

```yaml
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v7
        with: { ref: "${{ inputs.ref || github.ref }}" }
      - uses: actions/setup-python@v6
        with: { python-version: "3.12" }
      - run: pip install -r requirements.txt   # or: pip install .
      - run: python -m playwright install --with-deps
      - uses: Peeps-Labs/peeps-action@v1
        with:
          framework: pytest
          mode: ${{ inputs.mode }}
          session-id: ${{ inputs.sessionId }}
```

For pytest, `inventory` is `pytest --collect-only`, `run` selects the tests
Peeps asked for by node id, and results stream to Peeps from a small pytest
plugin shipped in this repository (`python/peeps_pytest_plugin.py`). With
pytest-playwright installed, its `--output` directory (traces, screenshots,
videos) is uploaded in place of Playwright's HTML report; your own
`--tracing`/`--screenshot`/`--video` options decide what is in it.
`PEEPS_PYTHON` names the interpreter if it is not `python` or `python3` on the
`PATH`.

### What a pytest test reports

pytest suites that are not browser flows (hardware checks, say) report what
they leave behind. Nothing needs changing for the first three:

- **Skip reasons**: `pytest.skip("not supported on model X")` and skip/skipif
  reasons.
- **Failures**: the phase that failed (setup, call or teardown), the exception
  type and message, and the traceback as pytest prints it, assertion detail
  such as `assert 0.41 >= 0.6` included, plus the failed test's captured
  stdout, stderr and log output.
- **Measurements**: `record_property("sharpness", 0.41)`.
- **Files** the test saves, in either of two ways:

  ```python
  def test_focus(peeps_artifacts_dir, record_property, tmp_path):
      # 1. Anything written to this per-test directory is uploaded.
      (peeps_artifacts_dir / "frame.png").write_bytes(frame)
      # 2. Or attach a file you saved elsewhere (inside the repository or
      #    pytest's tmp_path). Plain pytest: works with or without Peeps.
      record_property("peeps_attachment", str(tmp_path / "histogram.csv"))
  ```

  `peeps_artifacts_dir` exists only when the action runs pytest. For a suite
  that also runs elsewhere, fall back in your own fixture:
  `request.getfixturevalue("peeps_artifacts_dir")` inside
  `try`/`except pytest.FixtureLookupError`, returning `tmp_path` instead.
  At most 20 files and 100 MB per test, 25 MB per file; files elsewhere, or
  under `.git`, `node_modules` or `.env*`, are refused and listed as omitted.

Under pytest-rerunfailures only the final attempt's evidence is reported;
under pytest-xdist it is reported once, by the controller.

**For Peeps' server**: this is optional fields on the test's final `test_end`
event (`POST /api/v1/runs/{id}/events`), each absent when empty. The
authoritative type is `PytestTestEndEvidence` in `src/pytest.ts`:

```jsonc
{
  "type": "test_end", "testName": "test_focus", "status": "failed", "duration": 812,
  "error": "...", "errorStack": "...",             // as before
  "skipReason": "not supported on model X",        // status "skipped"
  "failure": {                                     // status "failed"
    "phase": "call",                               // "setup" | "call" | "teardown"
    "exceptionType": "AssertionError",             // module-qualified unless builtin; null if none
    "message": "focus too soft\nassert 0.41 >= 0.6",
    "traceback": "def test_focus(...):\n>       assert ..."   // longreprtext, middle trimmed
  },
  "properties": [{ "name": "sharpness", "value": 0.41 }],     // ≤ 50; scalars, else text
  "propertiesOmitted": 3,
  "output": [{ "name": "Captured stdout call", "text": "..." }], // status "failed"
  "attachments": [{ "name": "frame.png", "path": "data/<runId>-evidence-frame.png", "size": 12345 }],
  "attachmentsOmitted": [{ "name": "hosts", "reason": "outside the workspace" }],
  "evidenceTrimmed": true                          // only when cut to its 256 KB budget
}
```

`attachments[].path` is batch-relative, in the same `data/` shape as the
pytest-playwright output files, and is uploaded after pytest exits, so it may
arrive a little after the event (or not at all, if the upload fails).

`contents: read` is all this needs. When Peeps opens a fix branch it pushes with
its own installation token, supplied for that one call, not with your
`GITHUB_TOKEN`.

Outside GitHub Actions there is no OIDC token, so set `PEEPS_API_KEY` instead.

## Failure evidence

In Playwright `report` and `run` modes, Peeps defaults an unset `use.screenshot`
to `"only-on-failure"` and, when Playwright’s FFmpeg is installed, an unset
`use.video` to `"retain-on-failure"`. If the encoder is missing, Peeps warns
to run `npx playwright install ffmpeg` and leaves implicit video off so a
system-browser suite keeps working. Explicit video settings still win. Failed
attempts get evidence even without retries. Explicit repository, project and
`test.use` settings still win, including `"off"` and options with a `mode`.
Trace settings, viewport and device scale are unchanged. Inventory, agent-mode
`run_tests`, and pytest do not use these Playwright defaults.

The action loads your config through a temporary wrapper beside it, preserving
config-relative paths without changing the original file. `config.configFile`
during execution names that wrapper. It is removed on ordinary exit, including
a failed run. If the directory is not writable, the action warns that defaults
could not be applied and runs your original config instead; set the capture
options in your config to enable evidence in that case.

Video records throughout each test and is discarded for passing attempts, so it
adds recording work. Kept screenshots and video are included in the uploaded
HTML report, once per batch. See [SECURITY.md](SECURITY.md) for what leaves CI.

## Inputs

| Input | Required | What it is |
| --- | --- | --- |
| `mode` | no, defaults to `ci` | `inventory`, `run`, `report`, `agent`, or `ci` |
| `session-id` | for `run` and `agent` | The session id Peeps passes on dispatch. Unused by `inventory` and `report` |
| `config` | no | Playwright config path, relative to `working-directory` (pytest: the ini file, passed as `-c`) |
| `working-directory` | no | Where to run Playwright or pytest, relative to the repository root |
| `framework` | no, defaults to `auto` | `playwright`, `pytest`, or `auto` (see above) |

## Modes

| Mode | What runs on your runner |
| --- | --- |
| `inventory` | `playwright test --list --reporter=json` (pytest: `pytest --collect-only`), posted with the spec files |
| `run` | the tests Peeps asked for, reported live |
| `report` | this workflow's own test run, reported live |
| `agent` | a tool server for a Peeps agent session; every call is echoed to the job log |

`ci` is the default and means `report`. Peeps names the mode explicitly on every
dispatch it makes.

In `report` mode, a run on your **default branch** also refreshes the inventory,
because that run is the freshest list of tests there is. The default branch is
read from the event payload, so this works whatever yours is called.

## Common setups

**Tests in a subdirectory.** Point both inputs at it. `working-directory` is
relative to the repository root, and `config` is relative to
`working-directory`:

```yaml
      - uses: Peeps-Labs/peeps-action@v1
        with:
          working-directory: tools/e2e
          config: playwright.config.ts
```

**A default branch that is not `main`.** Change the `push` filter to match it.
Peeps mirrors only your default branch, so a `push` trigger on some other branch
produces reported runs but never refreshes the inventory:

```yaml
  push:
    branches: [develop]
```

**Pull requests from forks.** GitHub never grants `id-token: write` to a
workflow triggered by a fork's pull request, so this action cannot authenticate
there and the job fails. If you take fork contributions, filter the trigger:

```yaml
  pull_request:
    branches: [main]
    # fork PRs get no OIDC token; run Peeps on push instead
```

**Running the workflow by hand.** `mode: inventory` needs no session id:

```bash
gh workflow run peeps.yml -f mode=inventory
```

## GitLab CI/CD

The same action runs in a GitLab job. GitLab has no `uses:`, so the job fetches
the released bundle and runs it with Node, and the inputs are variables:

```yaml
# .gitlab-ci.yml
peeps:
  image: mcr.microsoft.com/playwright:v1.59.1-jammy
  timeout: 60m
  id_tokens:
    PEEPS_ID_TOKEN:
      aud: https://peepsai.com   # GitLab ID token -> Peeps; no Peeps secret needed
  rules:
    - if: $PEEPS_MODE                                   # started by Peeps
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"  # reports the MR's run
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH       # the branch Peeps mirrors
  script:
    - npm ci
    - git clone --depth 1 --branch v1 https://github.com/Peeps-Labs/peeps-action.git /tmp/peeps-action
    - node /tmp/peeps-action/dist/index.js
```

The Repository page in Peeps shows this job filled in for your project. The
action detects GitLab from `GITLAB_CI` and reads:

| Variable | What it is |
| --- | --- |
| `PEEPS_MODE` | Set by Peeps when it starts the pipeline: `inventory`, `run` or `agent`. Absent means `report` |
| `PEEPS_SESSION_ID` | Set by Peeps with `PEEPS_MODE` |
| `PEEPS_WORKING_DIRECTORY` | Where to run, relative to the repository root |
| `PEEPS_PLAYWRIGHT_CONFIG` | The Playwright config, relative to the working directory |
| `PEEPS_FRAMEWORK` | `playwright`, `pytest` or `auto` |
| `PEEPS_ID_TOKEN` | The ID token from `id_tokens:`; the job's identity |

Peeps starts pipelines with variables, so the project's **minimum role to use
pipeline variables** (Settings → CI/CD → Variables) must allow the role of the
access token Peeps was given (Maintainer).

## Development

```bash
npm ci
npx playwright install chromium
npm run typecheck
npm run build
npm test
```

`dist/` is the bundle `uses:` actually executes, so CI rebuilds it and fails if
it does not match `src/`. If you change anything under `src/`, commit the
rebuilt `dist/` with it.

The pytest tests run real pytest against `test/fixtures/pytest-suite`. They
skip when `python3` (or `PEEPS_PYTHON`) cannot import pytest; CI installs it
and sets `PEEPS_REQUIRE_PYTEST=1`, so there they fail instead.

The Playwright capture regressions execute the committed `dist/index.js` with
real Chromium and a local fake Peeps service. Rebuild before testing source changes.

## License

[MIT](LICENSE).
