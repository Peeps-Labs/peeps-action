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

`contents: read` is all this needs. When Peeps opens a fix branch it pushes with
its own installation token, supplied for that one call, not with your
`GITHUB_TOKEN`.

Outside GitHub Actions there is no OIDC token, so set `PEEPS_API_KEY` instead.

## Inputs

| Input | Required | What it is |
| --- | --- | --- |
| `mode` | no, defaults to `ci` | `inventory`, `run`, `report`, `agent`, or `ci` |
| `session-id` | for `run` and `agent` | The session id Peeps passes on dispatch. Unused by `inventory` and `report` |
| `config` | no | Playwright config path, relative to `working-directory` |
| `working-directory` | no | Where to run Playwright, relative to the repository root |

## Modes

| Mode | What runs on your runner |
| --- | --- |
| `inventory` | `playwright test --list --reporter=json`, posted with the spec files |
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

## Development

```bash
npm install
npm run typecheck
npm test
npm run build        # dist/ is committed — the action runs from it
```

`dist/` is the bundle `uses:` actually executes, so CI rebuilds it and fails if
it does not match `src/`. If you change anything under `src/`, commit the
rebuilt `dist/` with it.

## License

[MIT](LICENSE).
