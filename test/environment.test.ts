import { test } from "node:test";
import assert from "node:assert/strict";
import { planEnvironmentVariables } from "../src/environment";

test("exports the environment's name and its BASE_URL when the workflow sets none", () => {
  const { vars, log } = planEnvironmentVariables(
    { name: "staging", baseUrl: "https://staging.example.com" },
    {},
  );
  assert.deepEqual(vars, {
    PEEPS_ENVIRONMENT: "staging",
    PEEPS_BASE_URL: "https://staging.example.com",
    BASE_URL: "https://staging.example.com",
  });
  assert.match(log, /staging/);
});

test("keeps a BASE_URL the workflow set, and says which one runs", () => {
  const { vars, log } = planEnvironmentVariables(
    { name: "staging", baseUrl: "https://staging.example.com" },
    { BASE_URL: "https://pr-12.preview.example.com" },
  );
  assert.deepEqual(vars, {
    PEEPS_ENVIRONMENT: "staging",
    PEEPS_BASE_URL: "https://staging.example.com",
  });
  assert.match(log, /workflow's BASE_URL/);
});

test("treats an empty BASE_URL as unset", () => {
  const { vars } = planEnvironmentVariables(
    { name: "qa", baseUrl: "https://qa.example.com" },
    { BASE_URL: "" },
  );
  assert.equal(vars.BASE_URL, "https://qa.example.com");
});

test("names an environment that has no BASE_URL, and sets no URL", () => {
  const { vars } = planEnvironmentVariables({ name: "prod", baseUrl: null }, {});
  assert.deepEqual(vars, { PEEPS_ENVIRONMENT: "prod" });
});

test("exports nothing when Peeps sent no environment, or is older than this field", () => {
  assert.deepEqual(planEnvironmentVariables(null, {}).vars, {});
  assert.deepEqual(planEnvironmentVariables(undefined, {}).vars, {});
});
