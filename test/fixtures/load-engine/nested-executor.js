// Starts the real executor one process down, sharing its stdio: inside a pid namespace the
// executor is then not the namespace's init, and the kill of init would not be the kill of it.
const { spawn } = require("node:child_process");
const path = require("node:path");

const executor = path.resolve(__dirname, "../../../dist/load-executor.js");
const child = spawn(process.execPath, [executor], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
