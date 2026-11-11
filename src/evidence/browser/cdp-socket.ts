/** A CDP connection over the browser's debugging port: the network half of `cdp-coverage.ts`. */
import type { CdpConnection } from "./cdp-coverage";

const REPLY_TIMEOUT_MS = 5_000;
/** The lookup and the upgrade together: Playwright awaits the hook that waits on this. */
const CONNECT_DEADLINE_MS = 3_000;

export interface CdpSocket extends CdpConnection {
  close(): void;
  onClose(handler: () => void): void;
}

export async function connectCdp(port: number, options: { deadlineMs?: number } = {}): Promise<CdpSocket> {
  const deadline = Date.now() + (options.deadlineMs ?? CONNECT_DEADLINE_MS);
  const left = () => Math.max(1, deadline - Date.now());
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(left()) })).json()) as { webSocketDebuggerUrl?: string };
  if (!version.webSocketDebuggerUrl) throw new Error("The browser named no debugging socket");
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      // The deadline's reason first: closing mid-upgrade fires `onerror` at once.
      reject(new Error("Could not open the browser's debugging socket in time"));
      socket.onerror = null;
      socket.close();
    }, left());
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Could not open the browser's debugging socket"));
    };
  });
  const closers: Array<() => void> = [];
  let closed = false;
  let next = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const handlers: Array<(method: string, params: unknown, sessionId?: string) => void> = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown; sessionId?: string };
    if (message.id !== undefined) {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result);
    } else if (message.method) {
      for (const handler of handlers) handler(message.method, message.params, message.sessionId);
    }
  };
  // Idle or not, a closed socket is reported: what the browser runs after it is unseen.
  const onClosed = () => {
    if (closed) return;
    closed = true;
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error("The browser's debugging socket closed"));
    }
    pending.clear();
    for (const closer of closers) closer();
  };
  socket.onclose = onClosed;
  socket.onerror = onClosed;
  return {
    send(method, params = {}, sessionId) {
      if (closed) return Promise.reject(new Error("The browser's debugging socket closed"));
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`No reply to ${method}`));
        }, REPLY_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    onEvent(handler) {
      handlers.push(handler);
    },
    close() {
      socket.close();
      onClosed();
    },
    onClose(handler) {
      closers.push(handler);
    },
  };
}
