/**
 * The control frames between the supervisor, init and the executor (e4 plan v3 §2.4), and
 * init's ticket rule: one use per kind, refused when stale or foreign without being used up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { consumeTicket, decode, encode, MAX_FRAME_BYTES, newTicketState, relayable, type CtlFrame, type Ticket } from "../src/load/jail/ctl";

const PASSWORD = "A".repeat(42) + "w";
const TICKET: Ticket = { claimId: "claim-1", epoch: 1, planHash: "a".repeat(64), leaseSeq: 3, nonce: "n-1", monoDeadline: 5_000, wallDeadline: 1_700_000_005_000 };

const FRAMES: CtlFrame[] = [
  { type: "hello", nonce: "f".repeat(64) },
  { type: "ready" },
  { type: "start", ticket: TICKET },
  { type: "launch", ticket: TICKET },
  { type: "refused", reason: "stale_ticket" },
  { type: "refused", reason: "used_ticket" },
  { type: "refused", reason: "foreign_ticket" },
  { type: "refused", reason: "early_ticket" },
  { type: "installed", code: 0, signal: null, ms: 1234 },
  { type: "installed", code: null, signal: "SIGKILL", ms: 0 },
  { type: "launched" },
  { type: "exit", code: 0, signal: null },
  { type: "exit", code: null, signal: "protocol" },
  { type: "init", journey: { module: "load/journey.ts", export: "journey" }, baseURL: "https://shop.test", proxy: "http://127.0.0.1:3128", renewEveryMs: 2000, parallel: 4 },
  { type: "turn", turn: 1, slot: 2, password: PASSWORD, deadlineMono: 12_345.5 },
  { type: "cancel", turn: 1 },
  { type: "stop" },
  { type: "loaded", playwright: "1.46.0" },
  { type: "fatal", code: "playwright", message: "below 1.46" },
  { type: "fatal", code: "journey", message: "boom", location: "load/journey.ts:3" },
  { type: "outcome", turn: 1, kind: "success" },
  { type: "outcome", turn: 2, kind: "failure", message: "expected 200", location: "load/journey.ts:9" },
  { type: "outcome", turn: 3, kind: "timeout" },
  { type: "outcome", turn: 4, kind: "cancelled" },
];

test("every frame round-trips", () => {
  for (const frame of FRAMES) {
    const line = encode(frame);
    assert.ok(line.endsWith("\n"));
    assert.deepEqual(decode(line.slice(0, -1)), frame, frame.type);
  }
});

test("an extra field on a valid frame is dropped; an unknown type or a bad field is rejected", () => {
  assert.deepEqual(decode(JSON.stringify({ type: "stop", extra: 1 })), { type: "stop" });
  assert.deepEqual(decode(JSON.stringify({ type: "cancel", turn: 2, why: "x" })), { type: "cancel", turn: 2 });
  assert.deepEqual(decode(JSON.stringify({ type: "start", ticket: { ...TICKET, more: true } })), { type: "start", ticket: TICKET });
  const bad: unknown[] = [
    "not json",
    null,
    [],
    { type: "nope" },
    { type: "turn", turn: 0, slot: 1, password: PASSWORD, deadlineMono: 1 },
    { type: "turn", turn: 1.5, slot: 1, password: PASSWORD, deadlineMono: 1 },
    { type: "turn", turn: 2 ** 53, slot: 1, password: PASSWORD, deadlineMono: 1 },
    { type: "turn", turn: 1, slot: 0, password: PASSWORD, deadlineMono: 1 },
    { type: "turn", turn: 1, slot: 1, password: PASSWORD.slice(1), deadlineMono: 1 },
    { type: "turn", turn: 1, slot: 1, password: PASSWORD + "A", deadlineMono: 1 },
    { type: "turn", turn: 1, slot: 1, password: "+".repeat(43), deadlineMono: 1 },
    { type: "turn", turn: 1, slot: 1, password: PASSWORD, deadlineMono: 0 },
    { type: "turn", turn: 1, slot: 1, password: PASSWORD, deadlineMono: -1 },
    { type: "turn", turn: 1, slot: 1, password: PASSWORD, deadlineMono: "1" },
    { type: "turn", turn: 1, slot: 1, password: PASSWORD },
    { type: "init", journey: { module: "j.ts", export: "j" }, baseURL: "https://shop.test", proxy: "http://127.0.0.1:3128", renewEveryMs: 2000, parallel: 0 },
    { type: "init", journey: { module: "j.ts", export: "j" }, baseURL: "https://shop.test", proxy: "http://127.0.0.1:3128", renewEveryMs: 2000, parallel: 9 },
    { type: "init", journey: { module: "j.ts" }, baseURL: "https://shop.test", proxy: "http://127.0.0.1:3128", renewEveryMs: 2000, parallel: 1 },
    { type: "init", journey: { module: "j.ts", export: "j" }, baseURL: 3, proxy: "http://127.0.0.1:3128", renewEveryMs: 2000, parallel: 1 },
    { type: "loaded", playwright: "1".repeat(65) },
    { type: "fatal", code: "other", message: "x" },
    { type: "fatal", code: "journey", message: "x".repeat(2001) },
    { type: "fatal", code: "journey", message: "x", location: "l".repeat(501) },
    { type: "outcome", turn: 1, kind: "interrupted" },
    { type: "outcome", turn: 1, kind: "failure", message: 7 },
    { type: "refused", reason: "other" },
    { type: "installed", code: 0, signal: null },
    { type: "installed", code: 0.5, signal: null, ms: 1 },
    { type: "exit", code: "0", signal: null },
    { type: "hello", nonce: "short" },
    { type: "start" },
    { type: "start", ticket: { ...TICKET, monoDeadline: Number.NaN } },
    { type: "start", ticket: { ...TICKET, epoch: -1 } },
    { type: "start", ticket: { ...TICKET, claimId: "" } },
    { type: "launch", ticket: { ...TICKET, nonce: 1 } },
  ];
  for (const value of bad) assert.equal(decode(typeof value === "string" ? value : JSON.stringify(value)), null, JSON.stringify(value));
});

test("relayable: what init may pass on, in each direction", () => {
  const toExecutor = ["init", "turn", "cancel", "stop"];
  const toSupervisor = ["loaded", "fatal", "outcome"];
  for (const frame of FRAMES) {
    assert.equal(relayable(frame, "supervisor"), toExecutor.includes(frame.type), `from the supervisor: ${frame.type}`);
    assert.equal(relayable(frame, "executor"), toSupervisor.includes(frame.type), `from the executor: ${frame.type}`);
  }
  assert.ok(MAX_FRAME_BYTES >= 4096 && MAX_FRAME_BYTES <= 64 * 1024);
});

test("consumeTicket: fresh, past either deadline, used, foreign; stale and foreign do not use it up", () => {
  const config = { claimId: "claim-1" };
  const live = { monoMs: 1_000, wallMs: 1_700_000_001_000 };
  let state = newTicketState();
  assert.equal(consumeTicket("start", TICKET, live, config, state), "ok");
  assert.equal(consumeTicket("start", TICKET, live, config, state), "used", "one start per jail");

  state = newTicketState();
  assert.equal(consumeTicket("start", TICKET, { ...live, monoMs: 5_000 }, config, state), "stale", "the monotonic deadline passed");
  assert.equal(consumeTicket("start", TICKET, { ...live, wallMs: 1_700_000_005_000 }, config, state), "stale", "the wall deadline passed");
  assert.equal(consumeTicket("start", { ...TICKET, claimId: "claim-2" }, live, config, state), "foreign");
  assert.equal(consumeTicket("start", TICKET, live, config, state), "ok", "stale and foreign tickets left the use in place");

  state = newTicketState();
  assert.equal(consumeTicket("launch", TICKET, live, config, state), "early", "launch before installed is refused");
  assert.equal(consumeTicket("start", TICKET, live, config, state), "ok");
  assert.equal(consumeTicket("launch", TICKET, live, config, state), "early", "started is not installed");
  state.installed = true;
  assert.equal(consumeTicket("launch", TICKET, { ...live, monoMs: 6_000 }, config, state), "stale");
  assert.equal(consumeTicket("launch", TICKET, live, config, state), "ok");
  assert.equal(consumeTicket("launch", TICKET, live, config, state), "used");
});
