import { dedupeFindings, type ReviewFinding } from '../reviewSessionState';
import type { FindingStore, ReviewStep, StoredFinding } from './types';

// The numbered findings of one review. A finding gets the next unused number once; a later
// duplicate is merged into the numbered finding under the review-wide dedupe rule (stronger
// severity, combined sources, the corroboration bump, the better provenance, either side's
// "against goal" mark) and the numbered
// finding keeps its number, title, description and recommendation. A removed finding leaves a gap.
// Pure and vscode-free.

export type NewFinding = Omit<ReviewFinding, 'id'> & { batch: number };

export function emptyStore(): FindingStore {
  return { findings: [], nextNumber: 1, stepsRun: [], criticChecked: [] };
}

function withoutNumber(f: StoredFinding): NewFinding {
  const { id: _id, ...rest } = f;
  return rest;
}

/**
 * Adds one pass's findings. They are first deduped among themselves, then each is merged into the
 * first numbered finding it duplicates, or numbered anew.
 */
export function addFindings(store: FindingStore, incoming: NewFinding[]): { store: FindingStore; added: number[]; merged: number[] } {
  const findings = store.findings.map((f) => ({ ...f }));
  let nextNumber = store.nextNumber;
  const added: number[] = [];
  const merged = new Set<number>();
  for (const candidate of dedupeFindings(incoming) as NewFinding[]) {
    let duplicateOf: number | undefined;
    for (let i = 0; i < findings.length; i++) {
      const existing = findings[i];
      const pair = dedupeFindings([withoutNumber(existing), candidate]) as NewFinding[];
      if (pair.length !== 1) continue;
      // The pair collapsed: either merged under the dedupe rule, or one side was an unlocated copy of
      // the other. The numbered finding stays either way; only a real merge changes its fields.
      const survivor = pair[0];
      if (survivor !== candidate) {
        findings[i] = {
          ...existing,
          severity: survivor.severity,
          ...(survivor.sources ? { sources: survivor.sources } : {}),
          ...(survivor.confidence !== undefined ? { confidence: survivor.confidence } : {}),
          ...(survivor.provenance ? { provenance: survivor.provenance } : {}),
        };
      }
      // Either side's "against goal" mark survives, also when the pair collapsed to the candidate.
      if (candidate.againstGoal && !findings[i].againstGoal) findings[i] = { ...findings[i], againstGoal: true };
      duplicateOf = existing.id;
      break;
    }
    if (duplicateOf !== undefined) {
      merged.add(duplicateOf);
      continue;
    }
    findings.push({ ...candidate, id: nextNumber });
    added.push(nextNumber);
    nextNumber++;
  }
  return { store: { ...store, findings, nextNumber }, added, merged: [...merged].filter((n) => !added.includes(n)) };
}

export function markStepRun(store: FindingStore, step: ReviewStep): FindingStore {
  return store.stepsRun.includes(step) ? store : { ...store, stepsRun: [...store.stepsRun, step] };
}

/** The findings the critic has not given a verdict on yet. */
export function uncheckedFindings(store: FindingStore): StoredFinding[] {
  const checked = new Set(store.criticChecked);
  return store.findings.filter((f) => !checked.has(f.id));
}

/**
 * Applies the critic's verdicts. A rejected finding is removed, unless the developer worked on it
 * (explained it or drafted a comment), then it stays labelled as probably a false alarm.
 */
export function applyCriticVerdicts(
  store: FindingStore,
  verdicts: Array<{ id: number; keep: boolean }>,
  workedOn: ReadonlySet<number>,
): { store: FindingStore; removed: number[]; labelled: number[] } {
  const rejected = new Set(verdicts.filter((v) => !v.keep).map((v) => v.id));
  const removed: number[] = [];
  const labelled: number[] = [];
  const findings: StoredFinding[] = [];
  for (const f of store.findings) {
    if (!rejected.has(f.id)) { findings.push(f); continue; }
    if (workedOn.has(f.id)) {
      findings.push({ ...f, probablyFalseAlarm: true });
      labelled.push(f.id);
    } else {
      removed.push(f.id);
    }
  }
  const checked = new Set([...store.criticChecked, ...verdicts.map((v) => v.id)]);
  return { store: { ...store, findings, criticChecked: [...checked].sort((a, b) => a - b) }, removed, labelled };
}
