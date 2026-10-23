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

## Appium (WebdriverIO) suites

Native and hybrid mobile apps are tested with Appium, driven by
[WebdriverIO](https://webdriver.io) v9 with mocha and TypeScript specs. The
action finds them by itself when the working directory has a WebdriverIO
config (`wdio.conf.ts`, `.js`, `.mjs` or `.cjs`) and no Playwright config;
`framework: appium` says so outright. With one config per platform
(`wdio.android.conf.ts`, `wdio.ios.conf.ts`), name the one each job runs in
`config`.

Let WebdriverIO start Appium (`services: ["appium"]`, from
`@wdio/appium-service`) and install the driver your platform needs before the
action runs. Android runs on an Ubuntu runner's emulator:

```yaml
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v7
        with: { ref: "${{ inputs.ref || github.ref }}" }
      - uses: actions/setup-node@v5
        with: { node-version: 22 }
      - uses: actions/setup-java@v5
        with: { distribution: temurin, java-version: 17 }
      - run: npm ci
      - run: npx appium driver install uiautomator2
      # Build or download your debug .apk here; the config's
      # `appium:app` capability points at it.
      - name: Start an Android emulator
        run: |
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
          sudo udevadm control --reload-rules && sudo udevadm trigger --name-match=kvm
          IMAGE="system-images;android-34;google_apis;x86_64"
          yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "$IMAGE" emulator platform-tools > /dev/null
          echo no | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd -n ci -k "$IMAGE"
          nohup "$ANDROID_HOME/emulator/emulator" -avd ci -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect > "$RUNNER_TEMP/emulator.log" 2>&1 &
          "$ANDROID_HOME/platform-tools/adb" wait-for-device shell 'while [ -z "$(getprop sys.boot_completed)" ]; do sleep 2; done'
      - uses: Peeps-Labs/peeps-action@v1
        with:
          framework: appium
          config: wdio.android.conf.ts
          mode: ${{ inputs.mode }}
          session-id: ${{ inputs.sessionId }}
```

iOS runs on a macOS runner's simulator:

```yaml
    runs-on: macos-15
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v7
        with: { ref: "${{ inputs.ref || github.ref }}" }
      - uses: actions/setup-node@v5
        with: { node-version: 22 }
      - run: npm ci
      - run: npx appium driver install xcuitest
      # Build your app for the simulator here (xcodebuild … -sdk iphonesimulator);
      # the config's `appium:app` capability points at the .app.
      - name: Boot a simulator
        run: |
          UDID=$(xcrun simctl list devices available -j | jq -r '[.devices[][] | select(.name == "iPhone 16")][0].udid')
          xcrun simctl boot "$UDID"
          xcrun simctl bootstatus "$UDID" -b
      - uses: Peeps-Labs/peeps-action@v1
        with:
          framework: appium
          config: wdio.ios.conf.ts
          mode: ${{ inputs.mode }}
          session-id: ${{ inputs.sessionId }}
```

macOS minutes cost about ten times Linux ones; consider running the iOS job
only on changes to the iOS app.

**Hybrid apps: enable WebView inspection in the build you test.** Appium can
switch into a WebView, use DOM selectors there and read its HTML only when
the app allows it: `WebView.setWebContentsDebuggingEnabled(true)` on Android
(debug builds), `webView.isInspectable = true` on iOS 16.4 and later. Without
it, a test cannot reach the WebView's DOM, and a failure inside it is
reported with the native accessibility tree only.

How each mode works for Appium:

- **inventory**: WebdriverIO has no `--list`, so the action loads every spec
  file WebdriverIO's own config parser names into mocha, in a separate Node
  process, and walks the suite tree. No device session starts and no hook or
  test body runs, but your config and spec files are imported, so code at
  their top level (and in `describe` bodies) does run; `browser`, `driver`,
  `$`, `$$` and `@wdio/globals` are harmless stand-ins there. TypeScript
  loads through your own `tsx` (WebdriverIO v9 depends on it). A spec that
  fails to load is reported as a collection error. Each test is identified by
  its spec file and its `describe` titles plus `it` title, exactly as a
  Playwright test is.
- **report** and **run**: the action runs `npx wdio run` with a temporary
  config beside yours (`.peeps-<id>.wdio.conf.mts`, removed afterwards, and
  at once if the job is cancelled, when WebdriverIO is stopped too) that
  imports yours and adds Peeps' reporter and an `afterTest` hook; your own
  reporters, hooks and services stay. `run` narrows the spec files to the
  planned ones, passes a mocha grep over the planned titles, and adds a mocha
  root `beforeEach` (through `mochaOpts.require`, beside any of yours) that
  skips any test whose spec file and title path together are not planned, so
  a same-titled test in another planned file never runs; it shows as skipped
  in WebdriverIO's output and is not reported to Peeps.
  With `@wdio/junit-reporter` installed and not already in your config, its
  XML is uploaded to the batch too.

### What an Appium test reports

Results stream as they finish, one Peeps run per test. A failed test's final
`test_end` carries the pytest evidence fields (see above):
`failure { phase, exceptionType, message, traceback }`, where `phase` is
`call` for the test body and `setup` when a `before`/`beforeEach` hook failed
(every planned test under that hook's suite is then reported failed, since
mocha runs none of them), and `attachments`:

- `screenshot.png`, from `browser.saveScreenshot()`;
- `page-source.xml` (native screen: UiAutomator2's or XCUITest's hierarchy)
  or `page-source.html` (in a WebView), from `browser.getPageSource()`,
  uploaded as `data/<runId>-evidence-page-source.xml.dat` (or `.html.dat`)
  because Peeps' `data/` does not store xml or html under their own type.

When the driver reports one, `properties` holds the Appium context the test
failed in: `[{ "name": "context", "value": "WEBVIEW_com.example" }]`.

A capture that fails or exceeds 25 MB is listed in `attachmentsOmitted` with
its reason. Under mocha retries each retried attempt sends a failed
`test_end` and only the final attempt's evidence is kept.

One capability per config (one platform per config, named in `config`) is
the supported shape. With several, each test is reported once, from the
first capability that runs it; another capability's result for it is
logged in the job, not sent. In `run` mode each capability runs only the
planned spec files among its own (`wdio:specs` intersected with the plan),
and a capability with none of them is left out of the run.

With `specFileRetries`, a retry of a spec file runs on the same worker and
continues its tests' runs rather than duplicating them: a test that failed
in an attempt WebdriverIO will retry is sent as a retried attempt (a failed
`test_end` without evidence), and its run closes with the test's first pass
or with the last attempt. A test that already passed is not sent again when
the retry reruns its file.

### Agent mode for an Appium suite

When Peeps heals or generates an Appium test, it dispatches the same job in
`agent` mode, and the runner serves its tool calls (see SECURITY.md for what
that allows). For an Appium suite two things differ from Playwright:

- **`run_tests`** runs `npx wdio run` through the same temporary wrapper
  config as `run`, with `specs` narrowed to the one spec file and the
  agent's grep (a regular expression over mocha's full title: the
  `describe` titles and the test's own, joined by spaces) as mocha's
  `grep`. The result has Playwright's shape: `exitCode`, `durationMs`,
  `results` (one per test that ran: `title` as `Describe › test`, `file`
  relative to the repository, `line`, `status` `passed`/`failed`/`skipped`,
  `error`), `stderr`, and `stdoutTail` when the run failed or ran nothing.
  A failed test adds `errorStack`, `evidence` (its screenshot and page
  source, saved on the runner) and `pageSource` (the screen it failed on,
  redacted, up to 20,000 characters, for at most three tests). Nothing is
  reported to a Peeps run: results are read from the reporter's local
  record. Playwright's `project` argument is ignored.
- **Device tools**, with `device-tools: true` (GitLab:
  `PEEPS_DEVICE_TOOLS=true`). Peeps passes it on dispatch when its agent
  needs to look at the running app; it is off by default. (Peeps does not
  pass it yet: what its side needs is in
  [docs/device-tools-server-half.md](docs/device-tools-server-half.md).) Right after the
  session attaches, the action reads your WebdriverIO config's first
  capability set (WebdriverIO's own config parser, with the job's
  environment, so `"appium:app": process.env.APP_PATH` resolves as it does
  under `wdio run`), starts the `appium` your working directory resolves
  (its `node_modules/.bin`, or a parent's, else one on `PATH`) on a free
  loopback port with its log (warnings and errors only, so no request
  bodies or typed text) in `$RUNNER_TEMP/peeps-appium-<port>.log`, and
  opens a WebDriver session with those capabilities. `wdio:` keys are left
  out, and the session's `appium:newCommandTimeout` is raised to 30
  minutes unless yours is longer (or 0), because an agent thinks for
  longer than Appium's default minute between calls. The device steps of
  your workflow (emulator or simulator, app build) must therefore run in
  `agent` mode too, as they do in the workflows above.

  | Tool | What it does |
  | --- | --- |
  | `device_page_source` | The screen's page source: the native hierarchy as XML, or the page's HTML in a `WEBVIEW` context; 60,000 characters by default, 150,000 at most |
  | `device_screenshot` | A PNG of the screen, saved on the runner; returned as an image when it is under 180,000 base64 characters |
  | `device_find` | Elements by strategy (`accessibility id`, `id`, `xpath`, `class name`, `-android uiautomator`, `-ios predicate string`, `-ios class chain`, `css selector`) and selector: id, text, rect, displayed |
  | `device_tap` | Tap an element, or a point |
  | `device_type` | Type into an element, optionally clearing it first; the text is never echoed |
  | `device_swipe` / `device_scroll` | Swipe in a direction, across the screen or one element; scroll until an element is displayed |
  | `device_back` | The system back button |
  | `device_contexts` / `device_switch_context` | List `NATIVE_APP` and `WEBVIEW_…` contexts; switch between them |
  | `device_launch_app` / `device_terminate_app` | Activate or stop an app; by default the app under test (`appium:appPackage` / `appium:bundleId`) |
  | `device_logs` | logcat (Android) or syslog (iOS) since the last read, the last 200 lines by default |

  Every call is bounded: it waits at most a minute for the session to be
  ready and 50 seconds to finish. The session is deleted and Appium (its
  whole process group) stopped when Peeps ends the session, the session's
  time runs out, the job is cancelled (SIGTERM), or the loop fails.
  Without Appium installed in the working directory or on `PATH`, every
  device call answers with what to install.

## Failure evidence

In Playwright `report` and `run` modes, Peeps defaults an unset `use.screenshot`
to `"only-on-failure"` and, when Playwright’s FFmpeg is installed, an unset
`use.video` to `"retain-on-failure"`. If the encoder is missing, Peeps warns
to run `npx playwright install ffmpeg` and leaves implicit video off so a
system-browser suite keeps working. Explicit video settings still win. Failed
attempts get evidence even without retries. Explicit repository, project and
`test.use` settings still win, including `"off"` and options with a `mode`.
Trace settings, viewport and device scale are unchanged. Inventory, agent-mode
`run_tests`, pytest and Appium do not use these Playwright defaults.

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
| `config` | no | Playwright config path, relative to `working-directory` (pytest: the ini file, passed as `-c`; Appium: the WebdriverIO config) |
| `working-directory` | no | Where to run Playwright, pytest or WebdriverIO, relative to the repository root |
| `framework` | no, defaults to `auto` | `playwright`, `pytest`, `appium`, or `auto` (see above) |
| `device-tools` | no, defaults to `false` | `agent` mode, Appium suite: offer the `device_*` tools (see "Agent mode for an Appium suite"). Peeps passes it on dispatch |

## Modes

| Mode | What runs on your runner |
| --- | --- |
| `inventory` | `playwright test --list --reporter=json` (pytest: `pytest --collect-only`; Appium: a mocha load of the WebdriverIO specs), posted with the spec files |
| `run` | the tests Peeps asked for, reported live |
| `report` | this workflow's own test run, reported live |
| `agent` | a tool server for a Peeps agent session; every call is echoed to the job log. For an Appium suite `run_tests` runs WebdriverIO, and with `device-tools: true` Appium and a device session serve the `device_*` tools |

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
| `PEEPS_FRAMEWORK` | `playwright`, `pytest`, `appium` or `auto` |
| `PEEPS_DEVICE_TOOLS` | Set by Peeps with `PEEPS_MODE=agent` when its agent needs the device tools (Appium suites) |
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

The Appium tests collect `test/fixtures/appium` with real mocha and tsx (both
devDependencies) through the committed `dist/appium-collect.mjs`, and load
`dist/appium-reporter.js` through the wrapper config, so they too need a
rebuild after a source change. They start no device and no WebdriverIO.
The device tools run against a fake Appium (`test/support/fake-webdriver.ts`),
in-process and as the `appium` binary of a temporary working directory.

## License

[MIT](LICENSE).
