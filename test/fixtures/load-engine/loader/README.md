Loader fixtures for the load engine (`test/load-loader.test.ts`). Each `journey.ts`
(the monorepo's is `tools/e2e/src/journeys/checkout-quote.ts`) takes a Playwright
`APIRequestContext`, reads `GET /value`, and asserts on it with `expect` from
`@playwright/test`, so a wrong value throws at a known line. The tests run them in
place, inside the checked-out workspace.
