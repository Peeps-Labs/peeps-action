/**
 * What the gate did with each request it admitted (plan v3 §5, §7 property 6). Every admitted
 * request is debited for good; the journal says what is known about each:
 *
 *   - **attempted**: the proxy invoked the socket write;
 *   - **accepted**: the write callback confirmed handoff;
 *   - **responded**: a valid final response head was observed;
 *   - **received**: a trusted sink confirmed the complete request;
 *   - **denied**: a refusal before admission;
 *   - **cut**: an admitted exchange ended early, counted once by its first reason.
 *
 * The gate debits dense seqs, 1…debited. The sparse set of unattempted seqs preserves
 * the difference between a debit and a write attempt after the exchange is pruned.
 * Unresolved debits are those without a successful write callback.
 *
 * It does not survive a crash: Peeps draws the crash range from the last acknowledged debit and
 * the highest ceiling it granted (`reconcile.ts`).
 *
 * Pure: no clock, no I/O.
 */

export interface EntryMeta {
  turn: number;
  origin: string;
  method: string;
  /** At most `MAX_JOURNAL_PATH` characters. */
  path: string;
  /** The literal address the request went to. */
  address: string;
}

export const MAX_JOURNAL_PATH = 256;

interface Entry {
  meta: EntryMeta;
  written: "unresolved" | "accepted";
  responded: boolean;
  finished: boolean;
  cut?: string;
}

export interface Handoffs {
  debited: number;
  unattempted: ReadonlySet<number>;
}

export function wasAttempted(handoffs: Handoffs, seq: number): boolean {
  return Number.isSafeInteger(seq) && seq >= 1 && seq <= handoffs.debited && !handoffs.unattempted.has(seq);
}

export interface JournalSnapshot {
  debited: number;
  attempted: number;
  accepted: number;
  responded: number;
  received: number;
  unresolved: number;
  denied: Readonly<Record<string, number>>;
  cut: Readonly<Record<string, number>>;
}

export class Journal {
  private readonly open = new Map<number, Entry>();
  private readonly deniedBy = new Map<string, number>();
  private readonly cutBy = new Map<string, number>();
  private readonly unattempted = new Set<number>();
  private readonly receipts = new Set<number>();
  private counts = { debited: 0, accepted: 0, responded: 0 };

  /** Admitted and about to be written. Seqs come from the gate, in order, each once. */
  begin(seq: number, meta: EntryMeta): void {
    if (seq !== this.counts.debited + 1) throw new Error(`journal: seq ${seq} out of order (expected ${this.counts.debited + 1})`);
    this.counts.debited = seq;
    this.unattempted.add(seq);
    this.open.set(seq, { meta: { ...meta, path: meta.path.slice(0, MAX_JOURNAL_PATH) }, written: "unresolved", responded: false, finished: false });
  }

  /** Called at the write boundary. An error after invocation can mean partial delivery. */
  attempt(seq: number): void {
    this.unattempted.delete(seq);
  }

  handoffs(): Handoffs {
    return { debited: this.counts.debited, unattempted: new Set(this.unattempted) };
  }

  /** Record a complete receipt verified by the caller against this run's sink evidence. */
  confirmReceipt(seq: number): boolean {
    const handoffs = { debited: this.counts.debited, unattempted: this.unattempted };
    if (!wasAttempted(handoffs, seq) || this.receipts.has(seq)) return false;
    this.receipts.add(seq);
    return true;
  }

  /** The write's callback reported every byte taken. */
  accept(seq: number): void {
    const e = this.open.get(seq);
    if (!e || e.written === "accepted" || this.unattempted.has(seq)) return;
    e.written = "accepted";
    this.counts.accepted += 1;
    this.prune(seq, e);
  }

  /** A valid response head arrived for it. */
  respond(seq: number): void {
    const e = this.open.get(seq);
    if (!e || e.responded || this.unattempted.has(seq)) return;
    e.responded = true;
    this.counts.responded += 1;
  }

  /** Its exchange is over, however it ended. */
  finish(seq: number): void {
    const e = this.open.get(seq);
    if (!e) return;
    e.finished = true;
    this.prune(seq, e);
  }

  /** An admitted request ended early. Only its first reason counts. */
  cut(seq: number, reason: string): void {
    const e = this.open.get(seq);
    if (!e || e.cut !== undefined) return;
    e.cut = reason;
    this.cutBy.set(reason, (this.cutBy.get(reason) ?? 0) + 1);
  }

  deny(reason: string): void {
    this.deniedBy.set(reason, (this.deniedBy.get(reason) ?? 0) + 1);
  }

  /** The open entry for `seq`, if it is still open. */
  entry(seq: number): Readonly<Entry> | undefined {
    const e = this.open.get(seq);
    return e && { ...e, meta: { ...e.meta } };
  }

  /** Entries still open: unresolved writes and exchanges not yet over. */
  get openCount(): number {
    return this.open.size;
  }

  snapshot(): JournalSnapshot {
    const { debited, accepted, responded } = this.counts;
    return {
      debited,
      attempted: debited - this.unattempted.size,
      accepted,
      responded,
      received: this.receipts.size,
      unresolved: debited - accepted,
      denied: Object.fromEntries(this.deniedBy),
      cut: Object.fromEntries(this.cutBy),
    };
  }

  /** An unresolved write stays open: its delivery is the one thing the counts cannot say. */
  private prune(seq: number, e: Entry): void {
    if (e.written === "accepted" && e.finished) this.open.delete(seq);
  }
}
