/**
 * A short-lived, in-memory duplicate-call guard for write tools whose `invoke()` creates a new
 * artifact each time it runs (a ticket, a comment) rather than converging on an idempotent end
 * state. Language Model tools carry no session memory (KTD6), and `invoke()` — not the
 * confirmation dialog — is the only real safety boundary once `chat.tools.autoApprove` is on
 * (KTD1): without a guard, a retried or looped Agent Mode call with identical inputs creates a
 * second real ticket/comment with no reconciliation. Keyed on a content fingerprint of the
 * write's meaningful inputs, since Language Model tool calls carry no request id reliable enough
 * to dedupe on.
 */
export class RecentCallGuard {
  private readonly seen = new Map<string, number>();

  constructor(private readonly windowMs: number = 60000) {}

  /**
   * Returns true and records the call when this fingerprint was NOT claimed within the window;
   * returns false without recording when it WAS. The caller should treat false as "this looks
   * like a duplicate of a call just made -- don't repeat the write."
   */
  claim(fingerprint: string): boolean {
    const now = Date.now();
    this.prune(now);
    if (this.seen.has(fingerprint)) {
      return false;
    }
    this.seen.set(fingerprint, now);
    return true;
  }

  /** Releases a claim after the write it guarded actually failed, so a legitimate immediate
   * retry of a genuinely failed call is not itself mistaken for a duplicate. */
  release(fingerprint: string): void {
    this.seen.delete(fingerprint);
  }

  private prune(now: number): void {
    for (const [key, ts] of this.seen) {
      if (now - ts > this.windowMs) {
        this.seen.delete(key);
      }
    }
  }
}

const SEP = String.fromCharCode(31); // ASCII unit separator -- won't appear in ordinary text input

/**
 * Joins fingerprint parts with an ASCII unit-separator character (not a printable character
 * ordinary ticket keys, comment text, or summaries would contain), so fingerprint('a', 'bc') and
 * fingerprint('ab', 'c') never collide the way plain concatenation or a printable-character join
 * (space, comma) could.
 */
export function fingerprint(...parts: Array<string | number>): string {
  return parts.map((part) => String(part)).join(SEP);
}
