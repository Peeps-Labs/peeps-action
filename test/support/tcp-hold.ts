/**
 * A TCP listener that accepts and never answers, so a TLS handshake to it never completes
 * (load-freeze F3). It counts accepts, bytes read, and how each connection ended.
 */
import net from "node:net";

export interface TcpHold {
  port: number;
  stats: { accepted: number; bytes: number; ended: number; reset: number };
  close(): Promise<void>;
}

export async function tcpHold(): Promise<TcpHold> {
  const stats = { accepted: 0, bytes: 0, ended: 0, reset: 0 };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    stats.accepted += 1;
    sockets.add(s);
    let done = false;
    const end = (how: "ended" | "reset") => {
      if (done) return;
      done = true;
      stats[how] += 1;
    };
    s.on("data", (d) => (stats.bytes += d.length));
    s.on("end", () => end("ended"));
    s.on("error", () => end("reset"));
    s.on("close", (hadError) => {
      end(hadError ? "reset" : "ended");
      sockets.delete(s);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    stats,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
