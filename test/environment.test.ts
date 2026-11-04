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

test("a line break in the name can't start a line of its own in the job log", () => {
  for (const baseUrl of [null, "https://qa.example.com"]) {
    for (const current of [{}, { BASE_URL: "https://mine.example.com" }]) {
      const { vars, log } = planEnvironmentVariables(
        { name: "QA\n::ERROR::INJECTED\r\u0007", baseUrl },
        current,
      );
      assert.equal(log.split("\n").length, 1);
      assert.doesNotMatch(log, /[\r\u0007]/);
      // Only the log line changes: the test process gets what Peeps sent.
      assert.equal(vars.PEEPS_ENVIRONMENT, "QA\n::ERROR::INJECTED\r\u0007");
    }
  }
});

test("a URL's credentials stay out of the job log, and reach the test process", () => {
  const url = "https://user:hunter2@qa.example.com";
  for (const current of [{}, { BASE_URL: "https://mine.example.com" }]) {
    const { vars, log } = planEnvironmentVariables({ name: "qa", baseUrl: url }, current);
    assert.doesNotMatch(log, /hunter2/);
    assert.match(log, /https:\/\/\*\*\*@qa\.example\.com/);
    assert.equal(vars.PEEPS_BASE_URL, url);
  }
});

test("exports nothing when Peeps sent no environment, or is older than this field", () => {
  assert.deepEqual(planEnvironmentVariables(null, {}).vars, {});
  assert.deepEqual(planEnvironmentVariables(undefined, {}).vars, {});
});
