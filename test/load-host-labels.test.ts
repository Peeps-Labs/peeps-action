import assert from "node:assert/strict";
import { test } from "node:test";
import { hostLabels } from "../src/load/claim-body";

test("probe evidence drops arbitrary image and command text while preserving recognized metadata", async () => {
  const sentinel = "SYNTHETIC_CREDENTIAL";
  const outputs: Record<string, string> = {
    "/usr/bin/systemd-run": `systemd 255 (${sentinel})\n`,
    "/usr/bin/unshare": `unshare from util-linux 2.39.3 ${sentinel}\n`,
    "/usr/bin/chronyc": `Leap status     : Normal\nSystem time     : ${sentinel}\n`,
  };
  const labels = await hostLabels({ ImageOS: sentinel }, async (file) => outputs[file]);
  assert.equal(labels.image, "unknown");
  assert.equal(labels.tools, "unavailable; unavailable");
  assert.equal(labels.chrony, "normal");
  assert.ok(Object.values(labels).every((label) => !label.includes(sentinel) && label.length <= 128));
});

test("a failed host command leaves the other labels available", async () => {
  const labels = await hostLabels({ ImageOS: "ubuntu22" }, async (file) => {
    if (file === "/usr/bin/systemd-run") throw new Error("host probe failed");
    if (file === "/usr/bin/unshare") return "unshare from util-linux 2.37.2\n";
    return undefined;
  });
  assert.equal(labels.image, "ubuntu22");
  assert.equal(labels.tools, "unavailable; unshare from util-linux 2.37.2");
  assert.equal(labels.chrony, "unavailable");
});
