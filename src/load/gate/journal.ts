/**
 * What the gate did with each request it admitted (plan v3 §5, §7 property 6). Every admitted
 * request is debited for good; the journal says what is known about each:
 *
 *   - **unresolved**: admitted and handed to its socket, the write not confirmed (a write that
 *     failed part-way, or was reset with bytes still queued, stays here: delivery unknown);
 *   - **accepted**: the write's callback confirmed the kernel took every byte;
 *   - **received**: a response arrived. That proves the target saw the request's head, not its
 *     whole body, so it never moves a request from unresolved to accepted;
 *   - **denied**: never written, counted by reason, and never debited.
 *
 * `debited` = accepted + unresolved, the number each renewal reports, equal to the gate's
 * `admitted`. Seqs are dense (1…debited), so the set handed off is that range. Entries are kept
 * only while open: once a request's write is settled and its exchange over, only counts remain.
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
  received: boolean;
  finished: boolean;
}

export interface JournalSnapshot {
  debited: number;
  accepted: number;
  received: number;
  unresolved: number;
  denied: Readonly<Record<string, number>>;
}

export class Journal {
  private readonly open = new Map<number, Entry>();
  private readonly deniedBy = new Map<string, number>();
  private counts = { debited: 0, accepted: 0, received: 0 };

  /** Admitted and about to be written. Seqs come from the gate, in order, each once. */
  begin(seq: number, meta: EntryMeta): void {
    if (seq !== this.counts.debited + 1) throw new Error(`journal: seq ${seq} out of order (expected ${this.counts.debited + 1})`);
    this.counts.debited = seq;
    this.open.set(seq, { meta: { ...meta, path: meta.path.slice(0, MAX_JOURNAL_PATH) }, written: "unresolved", received: false, finished: false });
  }

  /** The write's callback reported every byte taken. */
  accept(seq: number): void {
    const e = this.open.get(seq);
    if (!e || e.written === "accepted") return;
    e.written = "accepted";
    this.counts.accepted += 1;
    this.prune(seq, e);
  }

  /** A response arrived for it. */
  receive(seq: number): void {
    const e = this.open.get(seq);
    if (!e || e.received) return;
    e.received = true;
    this.counts.received += 1;
  }

  /** Its exchange is over, however it ended. */
  finish(seq: number): void {
    const e = this.open.get(seq);
    if (!e) return;
    e.finished = true;
    this.prune(seq, e);
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
    const { debited, accepted, received } = this.counts;
    return { debited, accepted, received, unresolved: debited - accepted, denied: Object.fromEntries(this.deniedBy) };
  }

  /** An unresolved write stays open: its delivery is the one thing the counts cannot say. */
  private prune(seq: number, e: Entry): void {
    if (e.written === "accepted" && e.finished) this.open.delete(seq);
  }
}
