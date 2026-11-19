/**
 * The run's CA (plan v3 §5): constrained to the approved hosts, keys in memory only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRunCa } from "../src/load/gate/ca";
import { integer, oid, time } from "../src/load/gate/der";

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);

test("DER encoders write what X.509 expects", () => {
  assert.equal(integer(0).toString("hex"), "020100");
  assert.equal(integer(128).toString("hex"), "02020080", "a leading zero keeps it positive");
  assert.equal(integer(Buffer.from([0, 0, 1])).toString("hex"), "020101", "minimal");
  assert.equal(oid("1.2.840.10045.4.3.2").toString("hex"), "06082a8648ce3d040302");
  assert.equal(time(Date.UTC(2026, 0, 2, 3, 4, 5)).toString(), "\x17\x0d260102030405Z");
  assert.equal(time(Date.UTC(2050, 0, 1)).toString(), "\x18\x0f20500101000000Z");
});

test("the CA vouches only for approved hosts, for the run's length", () => {
  const ca = createRunCa({ hosts: ["shop.test", "api.shop.test"], nowMs: NOW, validForMs: 2 * 60 * 60 * 1000 });
  const root = new X509Certificate(ca.certPem);
  assert.equal(root.ca, true);
  assert.equal(new Date(root.validFrom).getTime(), NOW - 60 * 60 * 1000);
  assert.equal(new Date(root.validTo).getTime(), NOW + 2 * 60 * 60 * 1000);
  const leaf = ca.leaf("shop.test")!;
  const cert = new X509Certificate(leaf.certPem);
  assert.equal(cert.ca, false);
  assert.equal(cert.subjectAltName, "DNS:shop.test");
  assert.ok(cert.checkIssued(root) && cert.verify(root.publicKey));
  assert.equal(cert.checkHost("shop.test"), "shop.test");
  assert.equal(cert.checkHost("evil.test"), undefined);
  assert.equal(ca.leaf("shop.test"), leaf, "one leaf per host");
  assert.equal(ca.leaf("evil.test"), undefined);
  assert.equal(ca.leaf("SHOP.test"), undefined);
});

test("bad hosts and times are refused", () => {
  for (const hosts of [[], ["127.0.0.1"], ["*.shop.test"], ["Shop.test"], ["localhost"], ["shop.test."]]) {
    assert.throws(() => createRunCa({ hosts, nowMs: NOW, validForMs: 1000 }), Error, JSON.stringify(hosts));
  }
  assert.throws(() => createRunCa({ hosts: ["shop.test"], nowMs: NaN, validForMs: 1000 }));
  assert.throws(() => createRunCa({ hosts: ["shop.test"], nowMs: NOW, validForMs: 0 }));
});

test("the CA's name constraints are critical, permit only the approved names and exclude every address", (t) => {
  let text: string;
  const ca = createRunCa({ hosts: ["shop.test"], nowMs: NOW, validForMs: 1000 });
  try {
    text = execFileSync("openssl", ["x509", "-noout", "-text"], { input: ca.certPem, encoding: "utf8" });
  } catch {
    t.skip("openssl is not installed");
    return;
  }
  assert.match(text, /X509v3 Name Constraints: critical\s+Permitted:\s+DNS:shop\.test\s+Excluded:\s+IP:0\.0\.0\.0\/0\.0\.0\.0\s+IP:0:0:0:0:0:0:0:0\/0:0:0:0:0:0:0:0/);
  assert.match(text, /X509v3 Basic Constraints: critical\s+CA:TRUE, pathlen:0/);
  assert.match(text, /X509v3 Key Usage: critical\s+Certificate Sign, CRL Sign/);
});

test("architecture: ca.ts writes nothing to disk", () => {
  const source = readFileSync(path.join(__dirname, "..", "src", "load", "gate", "ca.ts"), "utf8");
  assert.doesNotMatch(source, /from "node:fs|require\("fs|writeFile/);
});
