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
- Outside GitHub Actions there is no OIDC token, so `PEEPS_API_KEY` is used
  instead. That is a stored credential, with the usual consequences.

## What leaves your runner

This is more than "test results". Concretely:

| Sent to Peeps | When |
| --- | --- |
| The **full source of every spec file** Playwright lists (pytest: every test module it collects) | `inventory`, and every `report`/`run` |
| The Playwright test list: files, titles, projects, tags (pytest: node ids, browsers, lines, markers) | `inventory`, `report`, `run` |
| Test results, timings, errors and stack traces | `report`, `run` |
| The **entire Playwright HTML report directory**, file by file (pytest: pytest-playwright's `--output` directory) | `report`, `run` |
| `BASE_URL`, if your workflow sets it | `report`, `run` |
| The commit sha, ref, repository and Actions job URL | all modes |
| Tool results in an agent session: file contents, diffs, test output | `agent` |

Two of those deserve emphasis.

**Your test code is sent to Peeps.** Spec file contents are uploaded so that
Peeps can analyse and heal the tests. Test code is code. If your specs embed
fixtures, internal URLs, or credentials, those go too.

**The HTML report can contain credentials for your own application.** If your
Playwright config enables tracing, screenshots or video, the report includes
them, and a trace records HTTP requests and responses, which means headers,
cookies and bearer tokens your tests obtained against your app. Nothing
redacts the report before upload. If that is not acceptable, turn tracing off
for the Peeps job, or do not run `report`/`run` modes.

**`BASE_URL` is sent verbatim** and is deliberately not masked, because masking
it would mangle every URL in every result. A `BASE_URL` of the form
`https://user:pass@staging.example.com` therefore reaches Peeps with the
credentials in it.

## What Peeps can do on your runner

Only in `agent` mode, and only for the duration of one session.

**In an agent session, Peeps has effective code execution on the runner.** We
state that directly rather than implying otherwise. The tools include writing a
file and running `npx playwright test`; Playwright loads your config file as
Node code; so an agent that writes a config and runs tests runs code with the
job's full environment. No arrangement of path checks changes that, and we have
not tried to pretend it does.

The limits that do exist are guardrails against mistakes, not a sandbox:

- Paths resolve inside the workspace. `..` and absolute paths are refused, as
  are `.git`, `node_modules` and `.env*`. Writes additionally refuse
  `.github/workflows`, because Peeps never edits workflow files.
- Tool results pass through a redactor that masks values present in the job's
  environment, including `GITHUB_TOKEN`, `ACTIONS_RUNTIME_TOKEN` and the OIDC
  request token. It cannot mask a secret that is not in this process's own
  environment, so a credential read out of a JSON file is not masked.
- Every tool call and its arguments are echoed to the job log, so the session is
  auditable after the fact. Arguments known to carry secrets are excluded from
  that log.
- `git_commit_push` refuses any branch not named `peeps/*`, and pushes with an
  installation token Peeps supplies for that one call, not your `GITHUB_TOKEN`.

Two specifics a reviewer should weigh:

- **The push stages everything.** It runs `git add -A`, so anything the job
  wrote to the working tree that your `.gitignore` does not exclude is committed
  to the `peeps/*` branch. Your `.gitignore` is the only thing bounding that.
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
  `git`, `npx playwright` and, for a pytest suite, `python -m pytest`, always
  with an argument array and never through a shell.
- For a pytest suite it also loads `python/peeps_pytest_plugin.py` from this
  repository into pytest (`-p peeps_pytest_plugin`). It uses the Python
  standard library only, imports nothing from your repository, and reads the
  plan file and writes the result files the action names.
