# Security

This action runs in your CI, with your secrets and your network access. This
document says plainly what it sends to Peeps and what Peeps can do on your
runner, so that you can decide whether that trade is one you want.

If you are reviewing this before installing it, the two sections that matter are
"What leaves your runner" and "What Peeps can do on your runner".

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository, under
the Security tab. Do not open a public issue for a security problem.

## Authentication

The job authenticates with the OIDC token GitHub issues to that specific job,
with audience `https://peepsai.com`. Peeps verifies it against GitHub's public
keys and reads the repository id from it.

Consequences worth knowing:

- Your repository stores **no Peeps credential**. There is nothing to rotate and
  nothing to leak from your secret store.
- The OIDC request token (`ACTIONS_ID_TOKEN_REQUEST_TOKEN`) is sent only to
  GitHub's own token service, never to Peeps.
- Every connection is outbound from your runner. Peeps never connects in, so a
  VPN-only or firewalled staging environment works without exposing it.
- No token is ever placed in a URL. All Peeps requests use an `Authorization`
  header.
- On GitLab CI/CD the job's identity is the ID token its `id_tokens:` block
  issues for audience `https://peepsai.com`, verified against your GitLab
  instance's public keys. It is sent only to Peeps. GitLab's job token
  (`CI_JOB_TOKEN`) is never sent anywhere and is masked in everything an agent
  session returns, as are the other `CI_` credentials.
- When Peeps pushes a fix branch on GitLab it uses the access token you gave
  Peeps, supplied for that one push, not the job token.
- Outside GitHub Actions and GitLab CI/CD there is no OIDC token, so
  `PEEPS_API_KEY` is used instead. That is a stored credential, with the usual
  consequences.

## What leaves your runner

This is more than "test results". Concretely:

| Sent to Peeps | When |
| --- | --- |
| The **full source of every spec file** Playwright lists (pytest: every test module it collects; Appium: every WebdriverIO spec file that holds a test) | `inventory`, and every `report`/`run`/attached run |
| The Playwright test list: files, titles, projects, tags (pytest: node ids, browsers, lines, markers; Appium: spec files, `describe`/`it` titles, `@tags` in titles, the line each title is written on, spec files that failed to load) | `inventory`, `report`, `run`, attached runs (files, titles, projects) |
| Test results, timings, errors and stack traces, and which attempt each result was (its retry index, from Playwright or pytest-rerunfailures) | `report`, `run`, attached runs |
| The **entire Playwright HTML report directory**, file by file (pytest: pytest-playwright's `--output` directory) | `report`, `run`, and `attach-finish` (the directory your `html` reporter wrote) |
| pytest only: skip reasons, `record_property` values, a failed test's captured stdout/stderr/log output, and the files a test saves in `peeps_artifacts_dir` or attaches with `record_property("peeps_attachment", path)` (only from inside the repository or pytest's temporary directory) | `report`, `run` |
| Appium only: for each **failed** test, a **screenshot of the device screen**, the **page source** of the screen it failed on (the native view hierarchy as XML, or the WebView's HTML), and the Appium context name; and, when `@wdio/junit-reporter` is installed and not already configured, the JUnit XML it writes (only for a run that is a single batch, since it holds every test the run ran) | `report`, `run` |
| `BASE_URL`, if your workflow sets it | `report`, `run` |
| For targeted runs, on a **pull request's** job on GitHub: the commit it's based on, the names of the files it changed, and the application's routes those changes can reach (`/orders/:id`, `/api/trpc/runs.list`). **Never the source, and never a patch**: the action reads your code on your runner to work this out, and nothing of it leaves | `report`, on `pull_request`, only when Peeps answers that the project has targeted runs on |
| For targeted runs, on a **push** of a project with them switched on: the application paths each test loaded and called, with no host and no query, and with what looks like an id, a token, a number or an address folded to `:id` (a best effort from each segment's shape: a private value shaped like a word stays). Only hosts sharing your base URL's last two labels, or listed in the project's settings, count | `report`, on a push |
| The commit sha, ref, repository and Actions job URL | all modes |
| The sha actually checked out (`git rev-parse HEAD`), and this action's version | `agent` |
| Tool results in an agent session: file contents, diffs, test output (for a failed Playwright test, its `error-context.md`, which holds the page's accessibility snapshot at the failure: up to 16 KB each and 128 KB per run, masked like every result. It is read only when it is a regular file, not a symlink, named `error-context.md`, inside the workspace or a Playwright project's output directory. Those checks stop a mistaken attachment, not a hostile spec: the output directory comes from the Playwright config, which an agent can edit, and a hard link passes them; for a failed Appium test, its page source), and the sha256 of each changed file's contents (files up to 5 MB; symlinks are never followed) | `agent` |
| Appium, only when the project's **Record video** setting is on in Peeps: a **screen recording of every planned test, pass or fail**, from its first `beforeEach` to its end, and for a failed test up to 8 still frames from the end of it | `report`, `run` |
| Appium, only with `device-tools: true`: what the device tools read from the app under test, when Peeps' agent calls them: **page source** of the screen (native hierarchy XML, or a WebView's HTML), element texts and positions, context names, **device logs** (logcat or syslog), and **screenshots** | `agent` |

Two of those deserve emphasis.

**Your test code is sent to Peeps.** Spec file contents are uploaded so that
Peeps can analyse and heal the tests. Test code is code. If your specs embed
fixtures, internal URLs, or credentials, those go too.

**The HTML report can contain credentials for your own application.** If your
Playwright config enables tracing, the report includes it. In Playwright
`report`/`run` modes this action also enables failure screenshots and retained
failure video when those settings are unset and its FFmpeg encoder is available. Explicit capture settings,
including `"off"` at repository, project or test level, are respected. This
action enables trace recording only on a push of a project with targeted runs
switched on, to read each test's paths, and it deletes every recording your own
trace setting wouldn't have kept before the report is built, so what's uploaded
is what you configured. A suite whose tests set their own trace with `test.use` is
never recorded this way. Screenshots and video show page
content. A trace records HTTP requests and responses, which means headers,
cookies and bearer tokens your tests obtained against your app. Nothing
redacts the report before upload. If that is not acceptable, turn tracing off
for the Peeps job, or do not run `report`/`run` modes. Attach modes enable
nothing: an attached run uploads what your own config captured.

**An Appium failure sends what was on the device.** The screenshot shows the
app's screen as the test left it, whatever data it displayed. The page source
is the text of every element on that screen: labels, field values your test
typed (the platforms normally show password fields masked; Peeps masks
nothing), and for a WebView its HTML as the page serialises it, including
hidden inputs and any token or state embedded in the markup. Nothing redacts either before upload.
Passing tests send neither. If that is not acceptable for a suite, use test
accounts and data in it, or do not run `report`/`run` modes for it.

**Record video sends the whole test, pass or fail.** With the project's
Record video setting on (off by default), every planned test's screen is
recorded for as long as it runs: every screen it reaches, everything typed
where the platform shows it, any code or token the app displays. Nothing is
masked or blurred. Turn it on only for suites that use test accounts and
data. A job that records and finds no ffmpeg installs it on the runner
(`sudo -n apt-get install ffmpeg` on Linux, `brew install ffmpeg` on macOS);
with the setting off, the action installs nothing.

**Device tools read the app under test, live.** With `device-tools: true`,
an agent session can read whatever the app shows: the page source of any
screen it reaches (every label and field value, and in a WebView the HTML
with hidden inputs and any token in the markup), element texts, the device
log since the last read (logcat or syslog: everything the app and the
system log, including whatever your app logs), and screenshots. Text results
are masked like every agent tool result (values of the job's secret-looking
environment variables), and also mask every value the session itself typed
into a secure field (an Android field whose `password` attribute is true, an
iOS `SecureTextField`, an HTML `password` input); typed text is never echoed
back or written to the job log. A secret that is neither, such as one the
app displays or logs on its own, is not masked, and **pixels cannot be
masked at all**: a screenshot shows what is on the screen. The tools can
also tap, type, swipe and launch or stop apps on the device, so an agent
can drive the app under test anywhere it can go, with whatever account the
test build is signed in with. Use test builds, accounts and data on the
device the Peeps job runs; leave `device-tools` unset (the default) and none
of this is offered.

**`BASE_URL` is sent verbatim** and is deliberately not masked, because masking
it would mangle every URL in every result. A `BASE_URL` of the form
`https://user:pass@staging.example.com` therefore reaches Peeps with the
credentials in it.

## What Peeps can do on your runner

**In both `run` and `agent` mode, Peeps can choose where your tests point.** When
a run or a session names a Peeps environment, the test processes (for an Appium
suite, WebdriverIO, and the device tools' read of your WebdriverIO config) get
`PEEPS_ENVIRONMENT`, and when it has a `BASE_URL`, `PEEPS_BASE_URL`, and `BASE_URL`
too unless your workflow sets one. Those tests run with the job's own secrets,
such as a login. A `BASE_URL` your workflow sets always wins, and the job log says
which URL runs.

The rest of this section applies only in `agent` mode, and only for the duration
of one session.

**In an agent session, Peeps has effective code execution on the runner.** We
state that directly rather than implying otherwise. The tools include writing a
file and running `npx playwright test` (in a pytest suite, `python -m pytest`,
or your own `.peeps/run-tests` hook); Playwright loads your config file as Node
code and pytest imports your `conftest.py` and test modules as Python; so an
agent that writes one of them and runs tests runs code with the job's full
environment. No arrangement of path checks changes that, and we have
not tried to pretend it does.

For an Appium suite, `run_tests` runs `npx wdio run`, which loads your
WebdriverIO config as Node code in the same way; and with `device-tools:
true` the action starts Appium (`node_modules/.bin/appium` in your working
directory or above it, else `appium` on `PATH`) on a loopback port and opens
a device session with your config's first capabilities. Appium is stopped,
with every process it started, when the session ends.

Appium's own log goes to `$RUNNER_TEMP/peeps-appium-<port>.log` on the
runner, at `warn` level. At its default level, and at `info`, Appium logs
the body of every request it receives, which would put the text an agent
types with `device_type` into that file; at `warn` request lines are not
logged at all, and the typing request is also marked sensitive
(`X-Appium-Is-Sensitive: true`), which Appium replaces with `**SECURE**` at
any level. The file is never uploaded or printed; Appium's startup output
that is printed to the job log when it fails to start is masked like a tool
result. On a self-hosted runner that keeps `RUNNER_TEMP`, the file stays
with it.

The limits that do exist are guardrails against mistakes, not a sandbox:

- Paths resolve inside the workspace. `..` and absolute paths are refused, as
  are `.git`, `node_modules` and `.env*`. Writes additionally refuse
  `.github/workflows`, because Peeps never edits workflow files, and `.peeps/`,
  where your own hooks live. `.peeps/run-tests` runs as a copy taken from the
  commit under test, and not at all while the checkout's `.peeps/` differs
  from that commit, so a heal cannot change the hook itself (it can change the
  tests the hook runs, as with Playwright).
- Tool results pass through a redactor that masks values present in the job's
  environment, including `GITHUB_TOKEN`, `ACTIONS_RUNTIME_TOKEN` and the OIDC
  request token. It cannot mask a secret that is not in this process's own
  environment, so a credential read out of a JSON file is not masked.
  `git_status` reports the sha256 of each changed file's unredacted bytes, so
  Peeps can check them against what it wrote. A digest does not reveal a
  file's contents, but it does confirm a guess of a short or predictable file.
  Paths in `run_tests` and `grep` results are masked too. A test title or
  `file` that masking changed carries `titleRedacted: true` or
  `fileRedacted: true`. Paths in `list_files` and `read_file` are not masked,
  because the agent must be able to open them: masking applies to result text
  and the paths inside results, and a path is not treated as a secret channel.
  The masking replaces any environment value of 8 or more characters outside
  the CI prefixes, not only secrets, so a title naming one (`production`) is
  masked too.
- Every tool call and its arguments are echoed to the job log, so the session is
  auditable after the fact. Arguments known to carry secrets are excluded from
  that log.
- `git_commit_push` refuses any branch not named `peeps/*`, and pushes with an
  installation token Peeps supplies for that one call, not your `GITHUB_TOKEN`.

Two specifics a reviewer should weigh:

- **What the push commits.** When Peeps names the files to commit (`paths`),
  only those are staged and committed. Before anything is staged, each must be
  a repo-relative path (an absolute one is refused) inside the workspace that is
  not under `.git`, `node_modules`, `.env*`, `.peeps/` or your CI configuration, not a
  directory, not ignored by your `.gitignore`, and reached through no symlink.
  These name checks are case-sensitive; on a case-insensitive filesystem a path
  that names an existing file in another case is refused because it does not
  resolve to itself. Git never follows a symlink when it stages. Your own commit
  hooks still run, and after the commit, before the push, the commit is checked
  to hold the listed paths and nothing else: a hook that stages another file, or
  a listed file that replaced a folder, makes the call refuse, the commit is
  undone, and nothing is pushed. Without `paths` the push stages everything
  (`git add -A`), so anything the job wrote to the working tree that your
  `.gitignore` does not exclude is committed to the `peeps/*` branch, except the
  action's own temporary WebdriverIO configs (`.peeps-*.wdio.conf.*`).
- **The push is a force push** to the `peeps/*` branch it names. An existing
  Peeps branch of the same name is replaced; nothing else can be.

### You control whether this can happen at all

Agent sessions start only when Peeps dispatches this workflow, which requires
you to have granted the Peeps GitHub App the `actions: write` permission.
**Withhold that permission and no agent session can ever run.** Peeps then
observes the runs your own CI starts, and reporting, inventory and failure
analysis all keep working. That is a supported configuration, not a degraded
one.

## Self-hosted runners

On a GitHub-hosted runner each job gets a fresh, disposable VM. On a self-hosted
runner, two things change:

- The installation token for a fix push is passed to `git` as a command-line
  argument, and process arguments are readable by other users on the same
  machine. On an ephemeral hosted runner this is not reachable; on a shared
  self-hosted runner it is. We intend to move it out of the argument list.
- Anything an agent session writes outside the workspace, or any state your
  tests leave behind, persists into later jobs.

We recommend GitHub-hosted runners, or ephemeral self-hosted runners, for
`agent` mode.

## Supply chain

- `dist/` is committed, because that is what `uses:` executes. It is built from
  `src/` by the `build` script, and CI rebuilds it on every push and fails if
  the result differs from what is committed. So the code you read in `src/` is
  the code that runs.
- Pin the action to a commit sha rather than a moving tag if you want to review
  exactly what you run: `uses: Peeps-Labs/peeps-action@<sha>`. A tag such as
  `@v1` is repointed at new releases.
- The action has no runtime dependencies. It bundles to one file and calls only
  `git`, `npx playwright`, for a pytest suite `python -m pytest`, and for an
  Appium suite `npx wdio run`, the job's own Node and, in `agent` mode with
  `device-tools: true`, your own `appium`, always with an argument array and
  never through a shell. The device tools talk to that Appium with plain
  HTTP requests on `127.0.0.1`; they do not load WebdriverIO.
- For a pytest suite it also loads `python/peeps_pytest_plugin.py` from this
  repository into pytest (`-p peeps_pytest_plugin`). It uses the Python
  standard library only, imports nothing from your repository, and reads the
  plan file and writes the result files the action names. It copies a test's
  attachments into the action's own temporary directory for upload, and
  refuses any path outside the repository, that directory and pytest's
  temporary directory, as well as `.git`, `node_modules` and `.env*`.
- For an Appium suite, `inventory` (and `report`/`run`, which collect first)
  runs `dist/appium-collect.mjs` in its own Node process in your working
  directory. It imports your WebdriverIO config and every spec file it names,
  through your own `tsx`, `@wdio/config` and `mocha`, so their top-level code
  runs as it would under `wdio`; it starts no device session and runs no hook
  or test body. `report`/`run` (and `run_tests` in `agent` mode) then write a
  temporary config beside yours (`.peeps-<id>.wdio.conf.mts` or `.mjs`, mode
  0600) that imports yours. It is removed when the run ends, or at once when
  the job is cancelled (SIGINT/SIGTERM), when the action also stops
  WebdriverIO's whole process group (SIGTERM, then SIGKILL after 3 seconds);
  a hard kill of the action itself (SIGKILL) can leave it behind, and
  `git_commit_push` never stages a `.peeps-*.wdio.conf.*` file. The wrapper
  adds `dist/appium-reporter.js` from this repository: a reporter and two
  hooks (and in `run` mode a mocha root hook that skips unplanned tests) that
  use only Node's standard library,
  read the plan file the action names, save a failed test's screenshot and
  page source into the action's temporary directory, and send results to
  Peeps. In `agent` mode with `device-tools: true`, the collector runs once more
  (`--capabilities`) to read the config's capabilities the same way; it
  imports the config only, not the specs.
