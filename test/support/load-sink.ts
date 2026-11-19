/**
 * An HTTPS sink for the gate's tests: a target on loopback with a certificate from a fixture
 * CA, which only tests inject as trust. It records every request that reaches it.
 */
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { createRunCa } from "../../src/load/gate/ca";

export interface Arrival {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
  body: string;
}

export interface Sink {
  port: number;
  caPem: string;
  arrivals: Arrival[];
  close(): Promise<void>;
}

export interface SinkOptions {
  /** The name the sink's certificate is for. */
  host?: string;
  /** Answer each request; the default is 200 with `ok`. */
  respond?: (arrival: Arrival, res: import("node:http").ServerResponse) => void;
}

export async function startSink(options: SinkOptions = {}): Promise<Sink> {
  const host = options.host ?? "sink.test";
  const ca = createRunCa({ hosts: [host], nowMs: Date.now(), validForMs: 60 * 60 * 1000 });
  const leaf = ca.leaf(host)!;
  const arrivals: Arrival[] = [];
  const server: Server = createServer({ cert: leaf.certPem, key: leaf.key.export({ type: "pkcs8", format: "pem" }), ALPNProtocols: ["http/1.1"] }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const arrival = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks).toString() };
      arrivals.push(arrival);
      if (options.respond) return options.respond(arrival, res);
      res.writeHead(200, { "content-type": "text/plain", "set-cookie": "s=1" });
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    caPem: ca.certPem,
    arrivals,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
