Journeys for `test/load-executor.test.ts`, `test/load-sessions.test.ts` and the hosted slice in
`test/load-jail.test.ts` (e4 plan v3 §3.1). This folder is the executor's working directory
(the checkout) in those tests. The journeys use `node:assert` and only a type import from
Playwright, so they also run at the 1.46 floor with `playwright-core` alone.
