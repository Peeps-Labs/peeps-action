/**
 * What the gate did with each request it admitted (plan v3 §5, §7 property 6). Every admitted
 * request is debited for good; the journal says what is known about each:
 *
 *   - **unresolved**: admitted and written, delivery not yet known (or never known: a write
 *     that failed part-way stays here);
 *   - **accepted**: the kernel took every byte;
 *   - **received**: a response arrived, so the target saw it (a received request is accepted);
 *   - **denied**: never written, counted by reason, and never debited.
 *
 * `debited` = accepted + unresolved, the number each renewal reports, equal to the gate's
 * `admitted`. A dial that fails is never admitted, so it is in none of these.
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
  path: string;
}

type State = "unresolved" | "accepted" | "received";

export interface JournalSnapshot {
  debited: number;
  accepted: number;
  received: number;
  unresolved: number;
  denied: Readonly<Record<string, number>>;
}

export class Journal {
  private readonly entries = new Map<number, { meta: EntryMeta; state: State }>();
  private readonly deniedBy = new Map<string, number>();
  private counts = { unresolved: 0, accepted: 0, received: 0 };

  /** Admitted and about to be written. Seqs come from the gate: each once. */
  begin(seq: number, meta: EntryMeta): void {
    if (this.entries.has(seq)) throw new Error(`journal: seq ${seq} begun twice`);
    this.entries.set(seq, { meta: { ...meta }, state: "unresolved" });
    this.counts.unresolved += 1;
  }

  /** The write's callback reported every byte taken. */
  accept(seq: number): void {
    const e = this.entries.get(seq);
    if (!e || e.state !== "unresolved") return;
    e.state = "accepted";
    this.counts.unresolved -= 1;
    this.counts.accepted += 1;
  }

  /** A response arrived for it. */
  receive(seq: number): void {
    const e = this.entries.get(seq);
    if (!e || e.state === "received") return;
    if (e.state === "unresolved") this.accept(seq);
    e.state = "received";
    this.counts.received += 1;
  }

  deny(reason: string): void {
    this.deniedBy.set(reason, (this.deniedBy.get(reason) ?? 0) + 1);
  }

  state(seq: number): State | undefined {
    return this.entries.get(seq)?.state;
  }

  meta(seq: number): EntryMeta | undefined {
    const e = this.entries.get(seq);
    return e && { ...e.meta };
  }

  /** Every seq handed to a socket, in order. */
  handedOff(): number[] {
    return [...this.entries.keys()].sort((a, b) => a - b);
  }

  snapshot(): JournalSnapshot {
    const { unresolved, accepted, received } = this.counts;
    return { debited: accepted + unresolved, accepted, received, unresolved, denied: Object.fromEntries(this.deniedBy) };
  }
}
