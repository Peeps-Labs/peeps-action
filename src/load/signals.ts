/**
 * The process signals a runner sends a cancelled job (e4 plan v3 §3.3 F5): SIGINT, SIGTERM
 * 7.5 s later, SIGKILL at 10 s. Each has a handler, so Node's default (exit, after which the
 * kernel flushes what was queued with a FIN) never runs: SIGINT cancels the run, SIGTERM cancels
 * it hard, which resets every upstream at once and skips the draining renewals.
 */
export interface LoadSignals {
  /** Aborted by SIGINT or SIGTERM. */
  signal: AbortSignal;
  /** Aborted by SIGTERM. */
  hard: AbortSignal;
  /** Every signal received, in order. */
  received: string[];
  dispose(): void;
}

type SignalSource = Pick<NodeJS.Process, "on" | "off">;

export function loadSignals(proc: SignalSource = process): LoadSignals {
  const soft = new AbortController();
  const hard = new AbortController();
  const received: string[] = [];
  const onInt = () => {
    received.push("SIGINT");
    soft.abort();
  };
  const onTerm = () => {
    received.push("SIGTERM");
    soft.abort();
    hard.abort();
  };
  proc.on("SIGINT", onInt);
  proc.on("SIGTERM", onTerm);
  return {
    signal: soft.signal,
    hard: hard.signal,
    received,
    dispose: () => {
      proc.off("SIGINT", onInt);
      proc.off("SIGTERM", onTerm);
    },
  };
}
