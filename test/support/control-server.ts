/**
 * Local HTTPS stand-ins for Peeps' load routes and GitHub's OIDC service, for the HTTP control
 * port's tests (`load-wire.test.ts`). Each is a `load-sink` under a test name that `lookup`
 * resolves to loopback, so SNI and the certificate's name are checked as in production.
 */
import type { LookupFunction } from "node:net";
import type { ServerResponse } from "node:http";
import { startSink, type Arrival, type Sink } from "./load-sink";

/** Every test name resolves to 127.0.0.1. */
export const loopbackLookup: LookupFunction = ((_host: string, options: unknown, callback?: unknown) => {
  const cb = (typeof options === "function" ? options : callback) as (...args: unknown[]) => void;
  const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
  if (all) cb(null, [{ address: "127.0.0.1", family: 4 }]);
  else cb(null, "127.0.0.1", 4);
}) as LookupFunction;

export type Responder = (arrival: Arrival, res: ServerResponse) => void;

export interface TestServer extends Sink {
  host: string;
  url: string;
  /** Replaces how the server answers from now on. */
  answer(responder: Responder): void;
}

export async function startTestServer(host: string, responder: Responder = (_a, res) => json(res, 200, {})): Promise<TestServer> {
  let current = responder;
  const sink = await startSink({ host, respond: (arrival, res) => current(arrival, res) });
  return Object.assign(sink, {
    host,
    url: `https://${host}:${sink.port}`,
    answer(next: Responder) {
      current = next;
    },
  });
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(text)), ...headers });
  res.end(text);
}

/** A JWT-shaped OIDC token. */
export function jwt(marker: string): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part({ aud: "peeps-load", marker })}.${Buffer.from(marker).toString("base64url")}`;
}
