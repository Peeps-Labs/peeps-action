# The load engine is on hold

1.17.0 ships `mode: load` as a refusal only. The engine built for PR 2 (supervisor,
executor, scheduler, budget, accounting, transport, lease, clock, containment, watchdog and
the TypeScript loader, with their tests and fixtures, and the copied v1 plan corpus) was
taken out before release, to be redesigned around PR 3's host network fence and
server-issued permits rather than fenced inside the action.

**Recover it from commit `4fdf908`** (`git show 4fdf908:src/load/supervisor.ts`, or
`git checkout 4fdf908 -- src/load test/load-*.test.ts test/support test/fixtures/load-engine test/fixtures/load-plans docs/load-loader.md`).
Its build entries (`dist/load.js`, `dist/load-executor.js`), the Sucrase dependency and the
CI job `load-stock-image` are in that commit's `package.json` and `.github/workflows/ci.yml`.

## Loader trials (2026-11-19)

The executor had to load a customer's TypeScript journey without their toolchain, and a failed
`expect` had to name the journey's own line. Five fixtures were trialled on Node 24.22.1 with
tsx 4.23.13, each importing the journey and calling it with a fake request that returns a
wrong value:

| Fixture | Node 24 type stripping | tsx (`node --import tsx`) | tsx CLI, cwd = journey's tsconfig folder | tsx CLI, cwd = monorepo root | Sucrase 3.35.1 + hooks |
|---|---|---|---|---|---|
| plain | passes, line 10 | passes, line 10 | — | — | passes, line kept |
| paths alias | `ERR_MODULE_NOT_FOUND` | `MODULE_NOT_FOUND` | passes, line 7 | — | passes, line kept |
| enum | `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | passes, line 15 | — | — | passes, line kept |
| extensionless imports | `ERR_UNSUPPORTED_DIR_IMPORT` | passes, line 7 | — | — | passes, line kept |
| monorepo (`extends` + `paths`) | `ERR_MODULE_NOT_FOUND` | `MODULE_NOT_FOUND` | passes, line 7 | `MODULE_NOT_FOUND` | passes, line kept |

- Node's stripping resolves no `paths`, no extensionless or directory import, and refuses
  `enum`.
- tsx reads one `tsconfig.json`, from the working directory, not the journey's nearest one,
  and is absent from most repositories.
- esbuild's transform moved assertion lines (10 → 27, 15 → 37), so it would need source
  maps; `esbuild-wasm` is 12.9 MB unpacked against Sucrase's 1.1 MB.
- Sucrase compiles value namespaces to nothing; the loader refused such files by name.
- The coordinator approved the Sucrase dependency on these results (review finding Sol C12).
  It is not a dependency of 1.17.0.

## Open review findings at `4fdf908`

From the adversarial re-review (`code-review-pr2-sol-r2.md`), still open when the engine was
held. The attach-dispatch finding was fixed in `4fdf908` and ships.

| Severity | Finding |
|---|---|
| Critical | The watchdog keeps bare PIDs/PGIDs and can signal unrelated processes after ID reuse; no readiness handshake before `go`, and nothing stops the run if the watchdog dies. |
| Major (C3) | Executor pause threshold (22.5 s) differs from the supervisor's (2 s), so an unexpired queued start can run after a freeze; renewals aren't scheduled from the granted duration. |
| Major (C4) | Startup queues a bare `go` after the lease check; a late reader loads customer code without checking expiry or generation. |
| Major (C5) | Limited containment still admits journeys and reports `traffic_stopped` for unknown cleanup; cgroup read errors read as empty; direct membership misses subgroups. |
| Major (C7) | A timeout frees the user before asynchronous reset finishes. |
| Major (C9) | Renewal and pause test oracles pick by wall-clock order and assume the full lease; no short grants in the fake port. |
| Major | Watchdog silence resets on its own timer gap; buffered beats are stamped at receipt. |
| Major | A stale renewal reply can stop the run, while a current stop-now at lease expiry falls into grace. |
| Major | `shared()` clock translation pairs a fresh monotonic reading with an earlier sample and can extend an issued deadline. |
| Major | Frequent IPC sampling accelerates the clock (a fake second sampled every 0.1 ms became 1.9 s). |
| Major | The allowed resume exception can exceed one send per user under parallel calls. |
| Minor (C13) | The macOS liveness test treats missing `/proc` as process death. |

Linux containment and stock-image execution were never verified, and stop latency at the
maximum plan size was never measured.
