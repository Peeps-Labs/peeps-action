Engine-only fixtures for the load engine. They are the action's own, outside the
pinned `test/fixtures/load-plans/v1/common/` corpus (which is a byte-for-byte copy of
peeps' and carries its root hash):

- `plan.json`, `limits.json`: a hand-written `{plan, limits}` in PR 1's shape.
- `limits-mapping.json`: how `limits` becomes the engine's per-phase budgets
  (`src/load/engine-limits.ts`), pinned.
- `histogram-vectors.json`: `hist/1` golden vectors (`src/load/timing.ts`).
- `loader/`: TypeScript journeys for the loader (`docs/load-loader.md`).
- `journeys/`: journeys the engine tests run against the sink.
