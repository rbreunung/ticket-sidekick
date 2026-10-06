// Email boilerplate cleanup step: sessions, consent/preview screens, reply parsing and decisions.
// Pure (vscode-free); re-exported through ../sessionState.ts.

import type { EmailImportItem } from '../../utils/emlParser';
import { applyBoilerplateCleanup, computeDroppedImageNames, buildPatternFromBlock, BOILERPLATE_KINDS, type BoilerplatePattern, type DetectedBlock } from '../../utils/emailBoilerplate';
import { CURRENT_SESSION_SCHEMA_VERSION } from './importTypes';
import { buildChatCommandLink, countedNoun, isCancellation, neutralizeMarkdownLinks } from './primitives';

// ---------------------------------------------------------------------------------------------
// Email boilerplate cleanup step (KTD8) — one session step in front of both email flows (batch
// ticket creation and "add email as comment"). `pending`: the Command Palette stored parsed items and
// the chat turn it opens runs detection; `consent`: some emails had no pattern match and the user is
// asked whether the Copilot model may look at them (R3); `preview`: the per-email list of detected
// blocks the user strips or keeps (R6-R8). Detection itself lives in src/utils/emailBoilerplate.ts;
// these are the pure screen builders and reply parser, orchestrated by emailHandler.ts.
// ---------------------------------------------------------------------------------------------

export type EmailCleanupTarget =
  | { kind: 'batch'; projectKey: string; fileName: string }
  | { kind: 'comment'; ticketKey: string };

// Per email: why no model check ran or what it found. 'not-needed' — patterns matched, or the body
// is empty; 'awaiting-consent' — unmatched, asked on the consent screen; 'declined' — the user
// replied skip model; 'checked'/'failed' — the model ran (a failed call counts as nothing detected);
// 'too-long' — unmatched but over MODEL_CHECK_MAX_CHARS, never sent.
export type EmailCleanupModelStatus = 'not-needed' | 'awaiting-consent' | 'declined' | 'checked' | 'failed' | 'too-long';

export interface EmailCleanupRow {
  id: string; // '1'..'N' in selection order
  item: EmailImportItem; // the original, as parsed — never mutated
  blocks: DetectedBlock[];
  modelStatus: EmailCleanupModelStatus;
  excluded: boolean; // R7: imports unchanged even on strip
}

export interface EmailCleanupSession {
  phase: 'pending' | 'consent' | 'preview';
  target: EmailCleanupTarget;
  rows: EmailCleanupRow[];
  savedBlocks: number[]; // block numbers (see numberEmailCleanupBlocks) already saved as patterns
  schemaVersion: number;
}

export function buildPendingEmailCleanupSession(items: EmailImportItem[], target: EmailCleanupTarget): EmailCleanupSession {
  return {
    phase: 'pending',
    target,
    rows: items.map((item, i) => ({ id: String(i + 1), item, blocks: [], modelStatus: 'not-needed', excluded: false })),
    savedBlocks: [],
    schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
  };
}

export interface NumberedCleanupBlock {
  n: number; // 1-based, across the whole preview in row order
  row: EmailCleanupRow;
  block: DetectedBlock;
}

export function numberEmailCleanupBlocks(session: EmailCleanupSession): NumberedCleanupBlock[] {
  const out: NumberedCleanupBlock[] = [];
  for (const row of session.rows) for (const block of row.blocks) out.push({ n: out.length + 1, row, block });
  return out;
}

// "3 footers, 1 signature" — kinds in header/footer/signature order.
export function describeBlockKinds(blocks: DetectedBlock[]): string {
  return BOILERPLATE_KINDS
    .map(kind => [kind, blocks.filter(b => b.kind === kind).length] as const)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => countedNoun(count, `${kind}(s)`))
    .join(', ');
}

const EXCERPT_MAX_CHARS = 80;

// Email-derived text shown on a trusted screen: one line, shortened, markdown links neutralized.
function untrustedSnippet(text: string, max = EXCERPT_MAX_CHARS): string {
  const line = text.replace(/\s+/g, ' ').trim();
  const cut = line.length > max ? `${line.slice(0, max).trimEnd()}…` : line;
  // These screens are trusted markdown, so besides [text](url) links, angle-bracket autolinks
  // (<command:…>, <https://…>) are defused too: backslashes first, so an email's own "\<" cannot
  // un-escape the added one, then every "<" becomes a literal "\<".
  return neutralizeMarkdownLinks(cut).replace(/\\/g, '\\\\').replace(/</g, '\\<');
}

function nothingDetectedLabel(status: EmailCleanupModelStatus): string {
  switch (status) {
    case 'declined': return 'nothing detected (model check skipped)';
    case 'failed': return 'nothing detected (model check failed)';
    case 'too-long': return 'nothing detected (too long for model check)';
    default: return 'nothing detected';
  }
}

// R3: the once-per-batch question whether the model may look at the unmatched emails. Every
// email-derived string (the subjects) is neutralized — the whole screen is trust-gated for its chips.
export function buildEmailCleanupConsent(session: EmailCleanupSession): string {
  const asked = session.rows.filter(r => r.modelStatus === 'awaiting-consent');
  const tooLong = session.rows.filter(r => r.modelStatus === 'too-long');
  const matched = session.rows.filter(r => r.blocks.length > 0).length;
  const single = session.rows.length === 1;
  const lines: string[] = [];
  lines.push(single
    ? 'Your boilerplate patterns found nothing in this email.'
    : `**${asked.length}** of ${session.rows.length} email(s) had no match against your boilerplate patterns` +
      (matched > 0 ? ` (${matched} matched).` : '.'));
  lines.push('');
  lines.push(`May the Copilot model look at ${asked.length === 1 ? 'it' : 'them'} to find confidentiality headers, legal footers and signatures? ` +
    'The email body is sent to the model only if you reply **model check**.');
  lines.push('');
  if (!single) {
    for (const r of asked) lines.push(`- **${r.id}** · ${untrustedSnippet(r.item.subject)}`);
    for (const r of tooLong) lines.push(`- **${r.id}** · ${untrustedSnippet(r.item.subject)} — _too long for model check, not sent_`);
    lines.push('');
  }
  lines.push(`${buildChatCommandLink('Model check', '@jira', 'model check')} · ` +
    `${buildChatCommandLink('Skip model', '@jira', 'skip model')} · ${buildChatCommandLink('Cancel', '@jira', 'cancel')}`);
  return lines.join('\n');
}

// R6/R8: the per-email list of what was found. Model-found blocks that can become a pattern show the
// exact start/end phrases `save <n>` would store (KTD9), so nothing unseen is ever saved.
export function buildEmailCleanupPreview(session: EmailCleanupSession, notice?: string): string {
  const numbered = numberEmailCleanupBlocks(session);
  const multi = session.rows.length > 1;
  const out: string[] = [];
  if (notice) out.push(notice, '');
  out.push('### Email boilerplate found', '');
  out.push(session.target.kind === 'batch'
    ? 'Reply **strip** to remove the blocks below before the tickets are created, or **keep** to import the emails unchanged.' +
      (multi ? ' Reply a row id to exclude that email from stripping (reply it again to include it).' : '')
    : `Reply **strip** to remove the blocks below from the comment for **${session.target.ticketKey}**, or **keep** to post the email unchanged.`);
  out.push('');
  for (const row of session.rows) {
    const subject = untrustedSnippet(row.item.subject);
    if (row.blocks.length === 0) {
      out.push(`**${row.id}** · ${subject} — ${nothingDetectedLabel(row.modelStatus)}`, '');
      continue;
    }
    const dropped = computeDroppedImageNames(row.item, row.blocks).length;
    const imagePart = dropped > 0 ? ` · ${dropped} image(s) would be dropped` : '';
    const toggle = multi
      ? ` · ${buildChatCommandLink(row.excluded ? `Include ${row.id}` : `Exclude ${row.id}`, '@jira', row.id)}`
      : '';
    const status = row.excluded ? ' — _excluded, imports unchanged_' : '';
    out.push(`**${row.id}** · ${subject} — ${describeBlockKinds(row.blocks)}${imagePart}${status}${toggle}`);
    for (const { n, block } of numbered.filter(x => x.row === row)) {
      const lineInfo = `${block.nonEmptyLineCount} line${block.nonEmptyLineCount === 1 ? '' : 's'}${block.capped ? ', capped' : ''}`;
      out.push(`- #${n} ${block.kind} (${block.source === 'model' ? 'found by the model' : 'pattern'}), ${lineInfo}: “${untrustedSnippet(block.excerpt)}”`);
      if (block.source !== 'model') continue;
      if (session.savedBlocks.includes(n)) {
        out.push('  - _saved as a pattern_');
        continue;
      }
      const pattern = buildPatternFromBlock(row.item.markdownBody, block);
      if (!pattern) continue;
      const phrases = `start “${untrustedSnippet(pattern.start, 200)}”${pattern.end ? `, end “${untrustedSnippet(pattern.end, 200)}”` : ''}`;
      out.push(`  - ${buildChatCommandLink(`Save #${n} as pattern`, '@jira', `save ${n}`)} — would store ${phrases}`);
    }
    out.push('');
  }
  out.push(`${buildChatCommandLink('Strip', '@jira', 'strip')} · ${buildChatCommandLink('Keep', '@jira', 'keep')} · ` +
    buildChatCommandLink('Cancel', '@jira', 'cancel'));
  return out.join('\n');
}

export type EmailCleanupReply =
  | { action: 'model-check' }
  | { action: 'skip-model' }
  | { action: 'strip' }
  | { action: 'keep' }
  | { action: 'toggle'; rowIds: string[] }
  | { action: 'save'; blockNumber: number }
  | { action: 'cancel' }
  | { action: 'invalid' };

// Replies per phase. Consent: `model check` (or yes) / `skip model` (or no, skip) / cancel.
// Preview: `strip`, `keep`, row ids to toggle exclusion (`3`, `2, 4`), `save <n>` / `save #n`, cancel.
export function parseEmailCleanupReply(reply: string, phase: 'consent' | 'preview', rowIds: string[]): EmailCleanupReply {
  const text = reply.trim().toLowerCase().replace(/[.!]+$/, '');
  if (phase === 'consent') {
    // Not a bare "check": JiraParticipant routes that to the connection check before any session router.
    if (/^model[\s-]*check$/.test(text) || text === 'yes' || text === 'y') return { action: 'model-check' };
    if (/^skip[\s-]*model$/.test(text) || ['no', 'n', 'nope', 'skip'].includes(text)) return { action: 'skip-model' };
    if (isCancellation(text)) return { action: 'cancel' };
    return { action: 'invalid' };
  }
  if (text === 'strip' || text === 'strip all' || text === 'remove') return { action: 'strip' };
  if (text === 'keep' || text === 'keep all') return { action: 'keep' };
  const save = /^save\s*#?\s*(\d+)$/.exec(text);
  if (save) return { action: 'save', blockNumber: Number(save[1]) };
  if (/^\d+(?:\s*[,\s]\s*\d+)*$/.test(text)) {
    const ids = Array.from(new Set(text.split(/[\s,]+/).filter(Boolean)));
    return ids.every(id => rowIds.includes(id)) ? { action: 'toggle', rowIds: ids } : { action: 'invalid' };
  }
  if (isCancellation(text)) return { action: 'cancel' };
  return { action: 'invalid' };
}

// R7/R10: strip applies each included row's blocks; excluded rows, rows with nothing detected and
// every row on keep come back as the original items.
export type EmailCleanupDecision = 'strip' | 'keep';

export function applyEmailCleanupDecision(
  session: EmailCleanupSession,
  decision: EmailCleanupDecision,
): { items: EmailImportItem[]; strippedCount: number; droppedImageCount: number } {
  let strippedCount = 0;
  let droppedImageCount = 0;
  const items = session.rows.map(row => {
    if (decision === 'keep' || row.excluded || row.blocks.length === 0) return row.item;
    const result = applyBoilerplateCleanup(row.item, row.blocks);
    strippedCount++;
    droppedImageCount += result.droppedImageNames.length;
    return result.item;
  });
  return { items, strippedCount, droppedImageCount };
}

// `save <n>` target: the numbered block and the pattern it would store, or why it can't be saved.
export function resolveSaveTarget(
  session: EmailCleanupSession,
  blockNumber: number,
): { ok: true; pattern: BoilerplatePattern } | { ok: false; reason: 'unknown' | 'pattern-found' | 'no-text' | 'already-saved' } {
  const entry = numberEmailCleanupBlocks(session).find(b => b.n === blockNumber);
  if (!entry) return { ok: false, reason: 'unknown' };
  if (entry.block.source !== 'model') return { ok: false, reason: 'pattern-found' };
  if (session.savedBlocks.includes(blockNumber)) return { ok: false, reason: 'already-saved' };
  const pattern = buildPatternFromBlock(entry.row.item.markdownBody, entry.block);
  return pattern ? { ok: true, pattern } : { ok: false, reason: 'no-text' };
}
