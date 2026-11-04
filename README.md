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

- **HTTP calls** of a failed test, made with `requests` or `httpx` (sync or
  async, `requests.get` and clients alike): method, URL, status, duration,
  headers and bodies, the last 20 calls, the failing one usually last. A
  passing test reports none. Before anything leaves the runner, a header,
  query parameter, form or JSON field named like a credential
  (`Authorization`, cookies, `token`, `password`, `api_key`, `secret`,
  `session`…) shows `[masked]`, URL credentials are removed, and any value of
  a secret-looking environment variable of the job (`*_TOKEN`, `*_SECRET`,
  `*_KEY`, `*PASSWORD*`…) shows `[redacted]` wherever it appears. Bodies are
  cut to 2,000 characters. When bodies carry personal data, set
  `PEEPS_HTTP_BODIES: off` in the job's `env` and only the method, URL,
  status and masked headers are reported.

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
  "httpExchanges": [{                              // status "failed"; the last 20
    "method": "POST", "url": "https://api.example.com/work-orders?api_key=[masked]",
    "status": 201, "durationMs": 42,               // status null when the call raised
    "requestHeaders": [{ "name": "Authorization", "value": "[masked]" }],
    "responseHeaders": [{ "name": "Content-Type", "value": "application/json" }],
    "requestBody": "{...}", "responseBody": "{...}", // ≤ 2,000 chars; absent with PEEPS_HTTP_BODIES=off
    "error": "ConnectionError: ..."                // only when the call raised
  }],
  "httpExchangesOmitted": 4,                        // earlier calls past the 20
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
  XML is uploaded to the batch too, when the run is a single batch (always
  in `run`); a `report` run that Peeps splits into several batches uploads
  none, since each file holds every batch's tests.

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
  record. Playwright's `project` argument is ignored. When Peeps names an
  environment for the session, WebdriverIO gets the same variables as
  Playwright's `run_tests` (`PEEPS_ENVIRONMENT`, `PEEPS_BASE_URL`, and
  `BASE_URL` unless the workflow sets it), and so does `run` mode.
- **Device tools**, with `device-tools: true` (GitLab:
  `PEEPS_DEVICE_TOOLS=true`). Peeps passes it on dispatch when its agent
  needs to look at the running app; it is off by default. (Peeps does not
  pass it yet: what its side needs is in
  [docs/device-tools-server-half.md](docs/device-tools-server-half.md).) Right after the
  session attaches, the action reads your WebdriverIO config's first
  capability set (WebdriverIO's own config parser, with the job's
  environment and the session's Peeps environment, so `"appium:app":
  process.env.APP_PATH` resolves as it does under `run_tests`), starts the `appium` your working directory resolves
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
| `mode` | no, defaults to `ci` | `inventory`, `run`, `report`, `agent`, `ci`, `attach-start` or `attach-finish` |
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
| `agent` | a tool server for a Peeps agent session; every call is echoed to the job log. `run_tests` runs Playwright, pytest (or your `.peeps/run-tests` hook) in a pytest suite, or WebdriverIO in an Appium suite, where `device-tools: true` also has Appium and a device session serve the `device_*` tools |
| `attach-start` | nothing: writes a config beside yours that adds the Peeps reporter to your reporters, and exports its path as `PEEPS_ATTACH_CONFIG` |
| `attach-finish` | nothing: uploads your run's HTML report and closes the run's batches |

`ci` is the default and means `report`. Peeps names the mode explicitly on every
dispatch it makes.

In `report` mode, a run on your **default branch** also refreshes the inventory,
because that run is the freshest list of tests there is. The default branch is
read from the event payload, so this works whatever yours is called.

## Common setups

**Keep your own test command and reporters (attach).** `report` runs
Playwright itself, with its own reporters. When your workflow already runs
the tests its way (a script, a JUnit or Zephyr reporter, a gate on the
result), attach Peeps to that step instead. Your command and config are not
changed; your step adds `--config "$PEEPS_ATTACH_CONFIG"` when it is set:

```yaml
      - uses: Peeps-Labs/peeps-action@v1
        continue-on-error: true
        timeout-minutes: 2
        with:
          mode: attach-start
          working-directory: e2e
      - run: npx playwright test ${PEEPS_ATTACH_CONFIG:+--config "$PEEPS_ATTACH_CONFIG"}
        working-directory: e2e
      - uses: Peeps-Labs/peeps-action@v1
        if: always()
        continue-on-error: true
        timeout-minutes: 10
        with:
          mode: attach-finish
```

The wrapper config loads yours unchanged and appends the Peeps reporter, so
every reporter you configured still runs. Inside your run, the reporter plans
it with Peeps from the tests Playwright is about to execute and streams the
results; the job still needs `id-token: write`. Neither attach step ever fails
the job, and the reporter never throws into your run: with Peeps unreachable,
failing or hanging, your run ends with the same result and your reporters see
the same tests (planning gives up after 60 seconds, the last results after
another 60). Attach does not change your capture settings: Peeps gets the
screenshots, video and traces your config already records, in the HTML report
your config writes. A run without an `html` reporter reports results only.

**Keep the container image on your Playwright version.** The
`mcr.microsoft.com/playwright:vX-jammy` image carries only Playwright X's
browsers. Use the tag that matches the `@playwright/test` version in your
lockfile, or add `npx playwright install --with-deps` after `npm ci`. When none
of your Playwright's browsers are on the runner, the action prints a warning
naming both versions before the tests start.

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

**pytest tests that need lab hardware.** In `agent` mode, `run_tests` runs the
one test a Peeps heal is fixing. For a pytest suite it runs pytest on the runner,
unless your repository has an executable `.peeps/run-tests`. Then Peeps runs that
instead, from the working directory and with the job's environment (and the
Peeps environment's variables, when the session names one):

```bash
.peeps/run-tests <junit-path> <node-id>...
```

Write a JUnit file to `<junit-path>` (pytest's own `--junitxml` output works).
That file is the verdict, not the exit code. Use the hook to send the run
through your own lab service: build the test image from this checkout, reserve
a device, run the node ids, and copy the JUnit back. Peeps never writes under
`.peeps/`, and runs a copy of `.peeps/` taken from the commit under test (and
only while the checkout's `.peeps/` still matches it), so a heal cannot change
the hook. The copy lives outside the checkout, so find the
repository from the working directory, not from the hook's own path. What the hook runs from the checkout, your tests and `conftest.py`
included, a heal can change, as with Playwright. A run must finish within
Peeps' tool timeout (10 minutes for a call the agent makes, 15 for the final
verification).

**A lab run longer than a heal can wait.** If your lab cannot finish in that
time (a device reservation alone can take 30 minutes), the hook may start the
run and return without a verdict: exit 0, write no JUnit file, and print a line
that is exactly

```text
peeps:pending
```

optionally followed by a space and a note, such as the lab run's link
(`peeps:pending https://lab.example.com/runs/42`). Print it last: Peeps reads
only the tail of the hook's output. `run_tests` then returns `pending: true`,
`results: null` and the note as `pendingNote`. A JUnit file always wins over the
marker, a non-zero exit ignores it, and pytest's own output never counts.
The healer then works from the failing run's recorded evidence, and Peeps opens
the fix as a draft pull request on its `peeps/*` branch. Have the lab upload
its JUnit for that fix to Peeps' results API (`POST /api/v1/projects/{project}/ci-results`)
with `gitRef` set to that branch and `commitSha` to its head commit (both are
in the draft's description): a passing test marks the pull request ready for
review, a failing one closes it with the failure. The hook runs before Peeps
commits, so it cannot know that branch or commit yet. The simplest setup has
your own CI run the lab on pushes to `peeps/*` branches, where both are known,
and the hook only print the marker.

**What `run_tests` reports for Playwright.** In `agent` mode, each result
names its spec as `file`, relative to the repository root (Playwright's own
report names it relative to its `testDir`), and its `line`. `file` is left out
when the spec lies outside the checkout or Playwright reports no `rootDir`.
Titles, files, errors and snippets pass through the same secret masking as
every tool result. A title the masking changed carries `titleRedacted: true`
(pytest results carry the same flag), and a file `fileRedacted: true`, so Peeps
knows the value is not the test's real name.
A failed result also carries `errorContext`: Playwright's `error-context.md`
for that test (the error, the test's source and, when the test had a page, the
page's accessibility snapshot at the failure), without Playwright's
"Instructions" preamble, masked, and cut to 16 KB (`errorContextTruncated`
says whether it was cut). One answer carries at most 128 KB of it, counted as
sent; failures past that, or whose file is over 1 MB, get
`errorContextOmitted: true`, so narrow the run with `grep`. The
runner advertises these to Peeps as the capabilities `result_files` and
`error_context`.

**A teardown project runs under its owner.** When `project` names a
Playwright teardown (a cleanup another project lists as its `teardown`),
`run_tests` selects the project it tears down instead, so the teardown starts
from the state it has in CI. That run has no file or `grep` filter, its
`results` hold every test of the chain, and the answer carries
`ranUnder: { projects, reason: "teardown" }`.

**What `run_tests` reports for pytest.** When pytest itself runs (not your
`.peeps/run-tests` hook), a failed result also carries the HTTP calls the test
made with `requests` or `httpx`, as `httpExchanges` (and `httpExchangesOmitted`),
the same calls and masking as a pytest test's evidence above, so a heal sees the
response that failed the test. Each test's calls are cut to 24 KB (bodies
first, then the oldest calls; `evidenceTrimmed` says so), and at most three
failed results carry them. The action loads its plugin for this with
`-p peeps_pytest_plugin`; your hook's runs carry no calls.

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

## 1.9.0

- Agent mode: when Peeps names an environment for a session, every test process
  `run_tests` starts gets the same variables run mode gives: `PEEPS_ENVIRONMENT`,
  and when the environment has a `BASE_URL`, `PEEPS_BASE_URL`, and `BASE_URL` too
  unless the workflow already sets it. That covers Playwright, its `--list`,
  pytest and your `.peeps/run-tests` hook, so a heal reproduces and verifies a
  failure in the environment it failed in. A workflow's own `BASE_URL` still wins,
  and the job log says which one runs. With an older Peeps, or a run that named no
  environment, nothing changes.
- The job log's environment line no longer carries control characters from an
  environment's name, or credentials from its URL, in either mode.

## 1.8.1

- Playwright's JSON report (the test list for inventory, report and run, and
  agent mode's `run_tests` results) is read from a file instead of stdout. A
  config that prints while loading broke every one of them: dotenv 17's
  `config()` logs "injected env (N) from .env" on every load.

## 1.8.0

- New modes `attach-start` and `attach-finish` report a workflow's own
  Playwright run, its command and reporters unchanged (see "Keep your own test
  command and reporters"). Neither can fail the job: an error, an unreadable
  environment, or a Peeps that is down, answers 5xx or never answers is a
  warning in the log.

## 1.7.0

- Agent mode: `run_tests` of a Playwright teardown project runs it the way CI
  does, after the project it tears down and that project's dependencies. Run
  alone, a teardown starts from nothing (no sign-in state, nothing to clean
  up), so a heal of a cleanup test failed every time it checked a fix. The
  run selects the owning projects with no file or `grep` filter, since either
  would drop the owner, and the answer says so as `ranUnder: { projects,
  reason: "teardown" }`. Every test of the chain is in `results`. A config
  that cannot be listed runs the project alone, as before.

## 1.6.0

- Run mode: when Peeps starts a run in an environment, the test process gets
  `PEEPS_ENVIRONMENT` (its name) and `PEEPS_BASE_URL` (its `BASE_URL`, when
  it has one), and `BASE_URL` too unless the workflow already sets it: a
  workflow's own `BASE_URL` always wins, and the job log says which one runs.
  No other variable or secret comes from Peeps. Read `process.env.BASE_URL` (or
  `PEEPS_BASE_URL`) in `use.baseURL`, or map `PEEPS_ENVIRONMENT` to your own
  settings. Needs a Peeps that sends the environment in the plan; with an older
  one nothing changes.

## 1.5.0

- Agent mode, Playwright: `run_tests` results name each spec's `file`
  relative to the repository root, and a failed result carries Playwright's
  `error-context.md` as `errorContext` (16 KB each, 128 KB per answer).
  Advertised as the runner capabilities `result_files` and `error_context`.
- Agent mode: Playwright results' `title`, `error` and `errorSnippet` now pass
  through the job's secret masking, as pytest's did; a masked title carries
  `titleRedacted: true`, on both paths, and a masked `file` `fileRedacted: true`.
  `grep` match paths are masked too.
- Agent mode: a failed `run_tests` run's summary carries the tail of what it
  printed (masked, 4000 characters). In a pytest suite, failed results carry
  the HTTP calls the test made (masked, at most three, 24 KB).
- Results, pytest: a failing test's `test_end` carries the HTTP calls it made
  (`httpExchanges`), masked on the runner, so failure analysis can read the
  failing call.
- Agent mode: `grep` reads Python files, and `apply_patch` takes a model's
  diff whose hunk header undercounts its lines without dropping the lines past
  the count.

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

**Releasing.** `ACTION_VERSION` in `src/version.ts` is reported to Peeps as
`runnerInfo.actionVersion`, and Peeps decides from it what the runner supports.
To release, merge a change into `main` that sets it to the new version (without
the `v`), renames the README's `## Unreleased` section to `## <version>`, and
rebuilds `dist/`. Once CI passes on `main`, the Release workflow
(`scripts/release.sh`) tags that commit `v<version>`, moves the major tag (`v1`)
to it, and publishes the GitHub release with that section as its notes. Nothing
is tagged by hand. A merge that leaves the version alone releases nothing, and
a version with no README section, or older than the newest release, fails the
workflow instead. If a run fails part-way, rerun it (or run the workflow by
hand on `main`): each step checks before it acts.

## License

[MIT](LICENSE).
