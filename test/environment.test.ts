import { test } from "node:test";
import assert from "node:assert/strict";
import { hideEnvironmentUrls, planEnvironmentVariables } from "../src/environment";

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

test("a name can't carry a legacy workflow command into the job log", () => {
  const name = "QA##[error]INJECTED ##[warning]AGAIN";
  const { vars, log } = planEnvironmentVariables({ name, baseUrl: null }, {});
  assert.doesNotMatch(log, /##\[/);
  assert.match(log, /QA/);
  assert.equal(vars.PEEPS_ENVIRONMENT, name);
});

test("a URL's secrets stay out of the job log, and reach the test process", () => {
  for (const url of [
    "https://user:hunter2@qa.example.com/app?token=hunter2#hunter2",
    "https://user:p@hunter2@qa.example.com/app",
    "HTTPS://user:hunter2@qa.example.com/app",
    "https://us\ter:hunter2@qa.example.com/app",
    "https://user:hun\nter2@qa.example.com/app",
    // A `/` or `\` in the credentials parses as a path, so these read as a
    // host called `user` or `hunter2` with the secret after it.
    "https://user:123/hunter2@qa.example.com",
    "https://hun/ter2@qa.example.com",
    "https://hunter2\\@qa.example.com",
  ]) {
    for (const current of [{}, { BASE_URL: "https://mine.example.com" }]) {
      const { vars, log } = planEnvironmentVariables({ name: "qa", baseUrl: url }, current);
      assert.doesNotMatch(log, /hunter2|hun|ter2|user/);
      assert.match(log, /<unreadable URL>/);
      assert.equal(vars.PEEPS_BASE_URL, url);
    }
  }
});

test("a query and fragment stay out of the job log", () => {
  const { log } = planEnvironmentVariables(
    { name: "qa", baseUrl: "https://qa.example.com/app?token=hunter2#hunter2" },
    {},
  );
  assert.doesNotMatch(log, /hunter2/);
  assert.match(log, /BASE_URL https:\/\/qa\.example\.com\/app$/);
});

test("logs a plain URL as it is, and a placeholder for one it can't read", () => {
  const plain = planEnvironmentVariables({ name: "qa", baseUrl: "https://qa.example.com" }, {});
  assert.equal(plain.log, "[peeps] environment qa, BASE_URL https://qa.example.com");
  for (const url of ["not a url secret", "ftp://user:secret@qa.example.com"]) {
    const { vars, log } = planEnvironmentVariables({ name: "qa", baseUrl: url }, {});
    assert.doesNotMatch(log, /secret/);
    assert.match(log, /<unreadable URL>/);
    assert.equal(vars.BASE_URL, url);
  }
});

test("exports nothing when Peeps sent no environment, or is older than this field", () => {
  assert.deepEqual(planEnvironmentVariables(null, {}).vars, {});
  assert.deepEqual(planEnvironmentVariables(undefined, {}).vars, {});
});

test("hideEnvironmentUrls hides only the values with an @, whole", () => {
  const hide = hideEnvironmentUrls({ PEEPS_ENVIRONMENT: "production", PEEPS_BASE_URL: "https://u:p/w@x.example.com", BASE_URL: "https://u:p/w@x.example.com" });
  assert.equal(hide("GET https://u:p/w@x.example.com/login failed in production"), "GET <unreadable URL>/login failed in production");
  assert.equal(hideEnvironmentUrls({ BASE_URL: "https://x.example.com" })("at https://x.example.com"), "at https://x.example.com");
  assert.equal(hideEnvironmentUrls({})("anything"), "anything");
});
