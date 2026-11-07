# Targeted runs: what the scan and the footprint can't see

The rule: what the scanner doesn't positively understand reads as global or unknown, and
the test runs. What's listed here can't be detected from the code or the trace, so a test
can be left out. The push after the merge catches these as escapes (the plan's PR 4); an
exotic form found there goes on this list rather than into a new special case.

## A footprint can miss a path

- A test takes a path only on a condition the recorded run didn't meet.
- A setup project's requests are that project's footprint, not its dependents'.
- A fixture requested by only some tests counts for every test using that `test`: this
  over-reports requests outside the trace, and never under-reports.
- What a server does behind a request. The reach walks that in the repository; another
  service isn't seen.
- A request from a Node client not in the list in `src/footprint/test-trace.ts`.

## The trace rule

- A library calling `test.use` at the top level of a module it's imported from. Recording
  deletes a trace that call asked for, unless the customer's own setting keeps it.
- A package's `test` handed to a local file through a path this can't follow, such as a
  function returning it, reads as a doubt: recording stays off, nothing is lost.

## The reach can miss a caller

- A request whose address can't be read is a doubt only where the walk reaches it. One
  elsewhere, calling a changed route by a computed address, isn't found.
- A browser file (`"use client"`) calling a route by a computed address. The trace shows
  the request on the recorded run.
- A client object not made by `.create()` of a known client, or a client library not on
  the list in `src/reach/adapters/fetch.ts`.
- A `.tsx` file with no `"use client"` that runs only in a browser reads as server code,
  which widens.
- A task, route or job dispatched by a name in data rather than code.
- Files read by a computed path: `readFileSync(join(dir, name))` on a source-adjacent
  file that isn't markdown or a known document. Unplaced files read global only when they
  are themselves changed and nothing names them.
- A change outside the repository: another service, a feature flag, data.

## Unsupported, so everything runs

- Reach: GitLab, attach mode, a head checkout, a framework with no adapter, routes outside
  the literal forms each adapter reads, Next `basePath`, `rewrites`, `i18n` and
  `pageExtensions`.
- Footprint: `--repeat-each`, a trace over 512 MB, more than 300 paths in one attempt.
