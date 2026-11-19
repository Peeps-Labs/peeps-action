# Load journeys: how the executor loads TypeScript

The load executor (`dist/load-executor.js`) runs one exported function from the customer's
repository: a Playwright API journey, usually TypeScript. It must load that file without the
customer's toolchain (no ts-node, tsx or Playwright's own transform), and a failed `expect`
must point at the journey's own line, as `npx playwright test` would.

## What the loader does

`src/load/loader.ts` registers synchronous hooks with `module.registerHooks` (Node 22.15 and
later; the action runs on Node 24):

- **Resolve.** Extensionless relative imports (`./helpers` → `./helpers.ts`, `./dir` →
  `./dir/index.ts`), TypeScript's `./x.js` for `./x.ts`, and the nearest `tsconfig.json`'s
  `compilerOptions.paths`, following `extends` (relative files and packages) and `baseUrl`.
- **Load.** `.ts`, `.tsx`, `.cts` and `.mts` are compiled with Sucrase, bundled into the
  executor. Sucrase keeps every line where it was, so the stack trace of a thrown assertion
  names the original `file:line` without source maps.
- **Playwright stays the customer's.** `@playwright/test`, `playwright` and `playwright-core`
  are external in the executor's esbuild entry. The journey's own imports resolve them as Node
  would, and the executor resolves `request` with `createRequire` from the job's
  `working-directory` (then from the journey's folder), so the run uses the customer's
  Playwright, never the action's development copy.

## The spike (build step 2a.3)

Five fixtures in `test/fixtures/load-engine/loader/`, each run in place inside the checked-out
workspace, on the host (Node 22 and 24) and in `mcr.microsoft.com/playwright:v1.59.1-jammy`
(CI job `load-stock-image`), by `test/load-loader.test.ts`:

| Fixture | What it needs | Sucrase |
|---|---|---|
| plain | type annotations, `import type` | passes, line kept |
| paths alias | `paths` with comments and trailing commas in `tsconfig.json` | passes, line kept |
| enum | `enum` and `const enum` | passes, line kept |
| extensionless imports | `./read`, `./helpers` (an `index.ts`), `./expected.js` naming a `.ts` | passes, line kept |
| monorepo | journey in `tools/e2e`, `tsconfig` `extends` a root base with `paths` into `packages/` | passes, line kept |

**The two options the plan named fail the fixtures.** Trialled on 2026-11-19 (Node 24.22.1,
tsx 4.23.13), importing each fixture's journey and calling it with a fake request that returns
a wrong value, so a working load ends in the fixture's own failed `expect`:

| Fixture | Node 24 type stripping | tsx (`node --import tsx`) | tsx CLI, cwd = the journey's tsconfig folder | tsx CLI, cwd = the monorepo root |
|---|---|---|---|---|
| plain | passes, line 10 | passes, line 10 | — | — |
| paths alias | `ERR_MODULE_NOT_FOUND` `@lib/expected` | `MODULE_NOT_FOUND` | passes, line 7 | — |
| enum | `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` (enum in strip-only mode) | passes, line 15 | — | — |
| extensionless imports | `ERR_UNSUPPORTED_DIR_IMPORT` (`./helpers`) | passes, line 7 | — | — |
| monorepo | `ERR_MODULE_NOT_FOUND` `@shop/api-client` | `MODULE_NOT_FOUND` | passes, line 7 | `MODULE_NOT_FOUND` |

Node's stripping resolves no `paths`, no extensionless or directory import, and refuses
`enum`. tsx reads one `tsconfig.json`, from the process's working directory (or
`TSX_TSCONFIG_PATH` with its CLI), not the journey's nearest one, so the monorepo journey loads
only when the job's working directory happens to be `tools/e2e`; from the repository root, the
usual `working-directory`, it fails. tsx is also the customer's dependency, absent from most
repositories. The coordinator approved the Sucrase dependency on these results (review finding
Sol C12).

**`esbuild-wasm`, the alternative, was not needed.** Measured with esbuild's own transform (the
same compiler): the plain fixture's assertion moves from line 10 to line 27, and the enum
fixture's from 15 to 37, so it would need source maps and `--enable-source-maps` to report the
original line. Its package is 12.9 MB unpacked against Sucrase's 1.1 MB.

**Choice: Sucrase 3.35.1** (MIT licence; README, "Third-party code").

### What Sucrase does not do

- **Namespaces that hold values** (`export namespace Paths { export const value = … }`). Sucrase
  compiles them to nothing, which would fail later as a misleading `ReferenceError`. The loader
  refuses such a file by name instead: "TypeScript namespaces aren't supported in load
  journeys". Type-only namespaces in `.d.ts` files are not loaded at all.
- **Decorator metadata and type checking.** It removes types; it never checks them. The journey
  has already passed the customer's own `tsc` or test run.
