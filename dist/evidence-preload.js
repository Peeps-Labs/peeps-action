"use strict";

// src/evidence/server/preload.cjs
var dir = process.env.PEEPS_SERVER_COVERAGE;
if (dir && process.env.NODE_V8_COVERAGE === dir) {
  const fs = require("node:fs");
  const path = require("node:path");
  const v8 = require("node:v8");
  const mark = (kind) => {
    try {
      fs.writeFileSync(path.join(dir, `${kind}-${process.pid}.json`), JSON.stringify({ pid: process.pid, at: Date.now() }));
    } catch {
    }
  };
  let taken = false;
  const take = () => {
    if (taken) return;
    taken = true;
    try {
      v8.takeCoverage();
      v8.stopCoverage();
      mark("taken");
    } catch {
    }
  };
  mark("pid");
  process.prependListener("SIGTERM", () => {
    take();
    if (process.listenerCount("SIGTERM") === 1) process.exit(143);
    setTimeout(() => process.exit(143), 5e3).unref();
  });
  process.on("exit", take);
}
