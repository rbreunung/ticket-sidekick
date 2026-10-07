import { extractJsonObject } from '../../utils/extractJsonObject';
import { UnparseableReplyError } from '../../utils/lmRetry';
import { neutralizeMarkdownLinks, sanitizeGfmCellText, normalizeShareText, type FileDiff } from '../reviewSessionState';

// Pure and `vscode`-free: the requirements pass's reply parsing and its two renderers (the chat
// block and the plain text for "Copy for Teams"). Everything derived from the ticket or the model
// is untrusted — the chat block is trust-gated by the caller, so nothing here may pass through
// un-neutralized.

export type RequirementSourceLabel = 'description' | 'comment' | 'inferred';
export type RequirementStatus = 'met' | 'not-evident' | 'unclear';

export interface CoverageRequirement {
  text: string;
  source: RequirementSourceLabel;
  status: RequirementStatus;
  evidence: string;
}

export interface OutOfScopeChange {
  file: string;
  note: string;
}

export interface ParsedRequirementsReply {
  reading: string;
  requirements: CoverageRequirement[];
  outOfScope: OutOfScopeChange[];
  conflict?: string;
  noClearRequirements: boolean;
  additionalFilesNeeded: string[];
  /** Out-of-scope entries dropped because they named a file outside the PR. */
  droppedOutOfScope: number;
}

/** A parsed reply plus what the renderers need to say about how the check was made. */
export interface RequirementsCoverage {
  ticketKey: string;
  reading: string;
  requirements: CoverageRequirement[];
  outOfScope: OutOfScopeChange[];
  conflict?: string;
  noClearRequirements: boolean;
  /** Files of the PR the pass was not shown (large PR), so affected requirements are marked unclear. */
  unseenFileCount: number;
  /** Set when the block was redone from a goal the user stated. */
  userGoal?: string;
}

const SOURCES: ReadonlySet<string> = new Set(['description', 'comment', 'inferred']);
const STATUSES: ReadonlySet<string> = new Set(['met', 'not-evident', 'unclear']);

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Reads the model's reply. Tolerant of a code fence and prose around the object; an unreadable reply
 * (no object, cut off mid-object, or no requirements list at all) throws `UnparseableReplyError` so
 * the caller retries it like a provider error.
 */
export function parseRequirementsReply(raw: string, prFilePaths: readonly string[]): ParsedRequirementsReply {
  const json = extractJsonObject(raw);
  if (!json) throw new UnparseableReplyError(raw);
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UnparseableReplyError(raw);
    obj = parsed as Record<string, unknown>;
  } catch (err) {
    throw err instanceof UnparseableReplyError ? err : new UnparseableReplyError(raw);
  }

  const noClearRequirements = obj.noClearRequirements === true;
  if (!Array.isArray(obj.requirements) && !noClearRequirements) throw new UnparseableReplyError(raw);

  const files = new Set(prFilePaths);
  let droppedOutOfScope = 0;
  const requirements: CoverageRequirement[] = [];
  const outOfScope: OutOfScopeChange[] = [];

  if (!noClearRequirements) {
    for (const entry of (obj.requirements as unknown[])) {
      if (!entry || typeof entry !== 'object') continue;
      const r = entry as Record<string, unknown>;
      const text = str(r.text);
      if (!text) continue;
      requirements.push({
        text,
        source: SOURCES.has(str(r.source)) ? (str(r.source) as RequirementSourceLabel) : 'inferred',
        status: STATUSES.has(str(r.status)) ? (str(r.status) as RequirementStatus) : 'unclear',
        evidence: str(r.evidence),
      });
    }
    for (const entry of Array.isArray(obj.outOfScope) ? (obj.outOfScope as unknown[]) : []) {
      if (!entry || typeof entry !== 'object') continue;
      const o = entry as Record<string, unknown>;
      const file = str(o.file);
      if (!file) continue;
      if (!files.has(file)) { droppedOutOfScope++; continue; }
      outOfScope.push({ file, note: str(o.note) });
    }
  }

  const files2 = Array.isArray(obj.additionalFilesNeeded)
    ? [...new Set((obj.additionalFilesNeeded as unknown[]).filter((p): p is string => typeof p === 'string' && p.trim().length > 0))]
    : [];

  return {
    reading: str(obj.reading),
    requirements,
    outOfScope,
    ...(str(obj.conflict) ? { conflict: str(obj.conflict) } : {}),
    noClearRequirements,
    additionalFilesNeeded: files2,
    droppedOutOfScope,
  };
}

export function buildCoverage(
  ticketKey: string,
  parsed: ParsedRequirementsReply,
  extra: { unseenFileCount?: number; userGoal?: string } = {},
): RequirementsCoverage {
  return {
    ticketKey,
    reading: parsed.reading,
    requirements: parsed.requirements,
    outOfScope: parsed.outOfScope,
    ...(parsed.conflict ? { conflict: parsed.conflict } : {}),
    noClearRequirements: parsed.noClearRequirements,
    unseenFileCount: extra.unseenFileCount ?? 0,
    ...(extra.userGoal ? { userGoal: extra.userGoal } : {}),
  };
}

const STATUS_ICON: Record<RequirementStatus, string> = { met: '✅ met', 'not-evident': '⚠️ not evident', unclear: '❔ unclear' };
const STATUS_WORD: Record<RequirementStatus, string> = { met: 'met', 'not-evident': 'not evident', unclear: 'unclear' };

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function unseenLine(count: number): string {
  return `${count} file${count === 1 ? ' was' : 's were'} not shown to this check, so requirements that could depend on ${count === 1 ? 'it' : 'them'} are marked unclear.`;
}

/** The "Requirements coverage" block for the chat response. Every ticket- or model-derived string is
 * neutralized, and table cells are kept on one line without pipes. */
export function renderCoverageMarkdown(coverage: RequirementsCoverage): string {
  const safe = (value: string): string => neutralizeMarkdownLinks(oneLine(value));
  const cell = (value: string): string => sanitizeGfmCellText(safe(value));
  const lines: string[] = [`### Requirements coverage — ${safe(coverage.ticketKey)}`, ''];

  if (coverage.userGoal) lines.push(`_Using your stated goal: ${safe(coverage.userGoal)}_`, '');
  if (coverage.reading) lines.push(`_How I read this ticket:_ ${safe(coverage.reading)}`, '');

  if (coverage.noClearRequirements) {
    lines.push(`No clear requirements found in ${safe(coverage.ticketKey)} — the requirements and scope checks were skipped.`);
    return lines.join('\n').trimEnd();
  }

  if (coverage.requirements.length > 0) {
    lines.push('| Requirement | Source | Status | Evidence |', '| --- | --- | --- | --- |');
    for (const r of coverage.requirements) {
      lines.push(`| ${cell(r.text)} | ${r.source} | ${STATUS_ICON[r.status]} | ${cell(r.evidence)} |`);
    }
    lines.push('');
  }

  if (coverage.outOfScope.length > 0) {
    lines.push('**Not accounted for by the ticket**', '');
    for (const o of coverage.outOfScope) lines.push(`- \`${safe(o.file)}\`${o.note ? ` — ${safe(o.note)}` : ''}`);
    lines.push('');
  }

  if (coverage.conflict) lines.push(`_Conflict in the ticket: ${safe(coverage.conflict)}_`, '');
  if (coverage.unseenFileCount > 0) lines.push(`_${unseenLine(coverage.unseenFileCount)}_`, '');

  return lines.join('\n').trimEnd();
}

/** The same content as plain text for pasting into a chat that does not render Markdown. */
export function renderCoverageText(coverage: RequirementsCoverage): string {
  const lines: string[] = [`Requirements coverage (${normalizeShareText(coverage.ticketKey)})`];
  if (coverage.userGoal) lines.push(`Using the stated goal: ${normalizeShareText(coverage.userGoal)}`);
  if (coverage.reading) lines.push(`How I read this ticket: ${normalizeShareText(coverage.reading)}`);

  if (coverage.noClearRequirements) {
    lines.push('No clear requirements found — the requirements and scope checks were skipped.');
    return lines.join('\n');
  }

  for (const r of coverage.requirements) {
    lines.push(`${STATUS_WORD[r.status]} — ${normalizeShareText(r.text)} (${r.source})`);
    if (r.evidence) lines.push(`   ${normalizeShareText(r.evidence)}`);
  }
  if (coverage.outOfScope.length > 0) {
    lines.push('Not accounted for by the ticket:');
    for (const o of coverage.outOfScope) lines.push(`   ${normalizeShareText(o.file)}${o.note ? ` — ${normalizeShareText(o.note)}` : ''}`);
  }
  if (coverage.conflict) lines.push(`Conflict in the ticket: ${normalizeShareText(coverage.conflict)}`);
  if (coverage.unseenFileCount > 0) lines.push(unseenLine(coverage.unseenFileCount));
  return lines.join('\n');
}

/** Added plus removed lines of a diff, not counting the `+++`/`---` file headers. */
function countChangedLines(diff: string): number {
  return diff.split('\n').filter((l) => (l.startsWith('+') && !l.startsWith('+++')) || (l.startsWith('-') && !l.startsWith('---'))).length;
}

/**
 * Fits as many of the PR's files into the requirements prompt as the token budget allows, smallest
 * first so the most files are seen. Pieces of one split file are rejoined under their path. Files
 * that do not fit are returned with their changed-line counts so the prompt can name them. Shown
 * files keep the PR's own order.
 */
export function packDiffFiles(
  fileDiffs: FileDiff[],
  budgetTokens: number,
): { shown: FileDiff[]; omitted: Array<{ path: string; changedLines: number }> } {
  const byPath = new Map<string, string>();
  for (const fd of fileDiffs) byPath.set(fd.path, (byPath.get(fd.path) ?? '') + (fd.diff.endsWith('\n') ? fd.diff : `${fd.diff}\n`));
  const entries = [...byPath].map(([path, diff]) => ({ path, diff, tokens: Math.ceil(diff.length / 4) }));

  const fits = new Set<string>();
  let used = 0;
  for (const e of [...entries].sort((a, b) => a.tokens - b.tokens)) {
    if (used + e.tokens > budgetTokens) continue;
    fits.add(e.path);
    used += e.tokens;
  }
  return {
    shown: entries.filter((e) => fits.has(e.path)).map((e) => ({ path: e.path, diff: e.diff })),
    omitted: entries.filter((e) => !fits.has(e.path)).map((e) => ({ path: e.path, changedLines: countChangedLines(e.diff) })),
  };
}
