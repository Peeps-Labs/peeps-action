// PQA-3201 PR 3: loaded into every app process the action starts (`NODE_OPTIONS=--require`).
// NODE_V8_COVERAGE writes nothing when a signal ends the process, so coverage is taken
// while it lives: on SIGTERM, and on any exit that still runs JavaScript. Each process
// registers first, so one that never took its coverage reads partial. Inert unless the
// action set both variables to the same directory. Dependency-free, never throws.
"use strict";
const dir = process.env.PEEPS_SERVER_COVERAGE;
if (dir && process.env.NODE_V8_COVERAGE === dir) {
  const fs = require("node:fs");
  const path = require("node:path");
  const v8 = require("node:v8");
  const mark = (kind) => {
    try {
      fs.writeFileSync(path.join(dir, `${kind}-${process.pid}.json`), JSON.stringify({ pid: process.pid, at: Date.now() }));
    } catch {
      // No marker: this process reads partial, which is safe.
    }
  };
  let taken = false;
  const take = () => {
    if (taken) return;
    taken = true;
    try {
      v8.takeCoverage();
      // Once taken, the exit would write every loaded script again (~140 MB on a Next app).
      v8.stopCoverage();
      mark("taken");
    } catch {
      // Not taken: partial.
    }
  };
  mark("pid");
  process.prependListener("SIGTERM", () => {
    take();
    // A listener replaces Node's default exit on SIGTERM: an app without its own handler
    // ends now, as it would have; one with a handler gets its chance first.
    if (process.listenerCount("SIGTERM") === 1) process.exit(143);
    setTimeout(() => process.exit(143), 5_000).unref();
  });
  process.on("exit", take);
}
