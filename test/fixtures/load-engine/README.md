Engine-only fixtures for the load engine. They are the action's own, outside the
pinned `test/fixtures/load-plans/v1/common/` corpus (which is a byte-for-byte copy of
peeps' and carries its root hash):

- `limits-mapping.json`: how `limits` becomes the engine's per-phase budgets
  (`src/load/engine-limits.ts`), pinned, for the corpus's golden plans and one
  synthetic busy plan.
- `histogram-vectors.json`: `hist/1` golden vectors (`src/load/timing.ts`).
- `loader/`: TypeScript journeys for the loader (`docs/load-loader.md`).
- `journeys/`: journeys the engine tests run against the sink.
- `v2/`: the bench's robots check, vendored, as a load journey, a Playwright spec and its
  config: `test/load-v2.test.ts` runs it both ways and compares the verdicts.
