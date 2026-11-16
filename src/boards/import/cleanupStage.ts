import type { Applied, ApplyProgress, Planned, Reduced } from '../../sessions/boardKind';
import type { ApplyLineResult, WritePlan } from '../../sessions/sessionTypes';
import {
  applyBoilerplateCleanup, buildModelCheckPrompt, buildPatternFromBlock, isTooLongForModelCheck, parseModelCheckReply, verifyModelBlocks,
  type BoilerplateKind, type BlockSource, type DetectedBlock,
} from '../../utils/emailBoilerplate';
import type { EmailImportItem } from '../../utils/emlParser';
import { UnparseableReplyError, withLmRetry } from '../../utils/lmRetry';
import { EMAIL_MODEL_SETTING } from '../boardModels';
import { EMAIL_CLEANUP_HANDLER, type EmailBodyChoice } from './emailRows';
import type { HandlerPayload, ImportHandler, ImportSession } from './handlers';
import type { ImportWorking } from './kind';
import { isEmailRow, newRows, rowKeyOf, type EmailBoardRow, type ImportData, type ImportDeps } from './read';
import * as path from 'path';

// The boilerplate cleanup of an email import, a stage before its New tab. The patterns from
// `ticketSidekick.email.boilerplatePatterns` are found when the emails are read. An email they do
// not match may be checked by a language model, but only after the developer agrees on the board:
// the check is a plan whose preview names every email that would be sent and the model, applied
// like a write. Then the developer strips or keeps what was found, and the New tab opens with
// the chosen bodies. The emails are never changed on disk. vscode-free.

const NAME = EMAIL_CLEANUP_HANDLER;
const FINISH_FIRST = 'Finish the email cleanup first: strip or keep the boilerplate it found.';

/** Why an email was or was not checked by the model, as the chat's cleanup step names it. */
export type ModelStatus = 'not-needed' | 'awaiting-consent' | 'declined' | 'checked' | 'failed' | 'too-long';

interface RowState {
  /** Every block found by the patterns and the model together, once the model checked the email. */
  blocks?: DetectedBlock[];
  status?: ModelStatus;
  /** The model that checked the email. */
  modelId?: string;
  excluded?: boolean;
}

interface CleanupState {
  rows: Record<string, RowState>;
  /** The developer's answer to the consent step, for the emails that were awaiting it. */
  consent?: 'given' | 'declined';
  /** Strip or keep: the cleanup is finished. */
  decision?: 'strip' | 'keep';
  /** The bodies a strip chose, by row key. */
  bodies?: Record<string, EmailBodyChoice>;
  /** Blocks saved as patterns, by block id. */
  saved?: string[];
}

type CleanupPayload = HandlerPayload & (
  | { op: 'check'; keys: string[]; modelId: string; save: boolean }
  | { op: 'save'; key: string; block: string }
);

export type CleanupPhase = 'consent' | 'preview' | 'done';

export interface CleanupBlockView {
  id: string;
  kind: BoilerplateKind;
  source: BlockSource;
  /** The block's first line, as found; email text. */
  excerpt: string;
  lines: number;
  saved: boolean;
  /** A model-found block that can be saved as a pattern. */
  savable: boolean;
}

export interface CleanupRowView {
  id: string;
  ref: string;
  subject: string;
  status: ModelStatus;
  modelId?: string;
  excluded: boolean;
  blocks: CleanupBlockView[];
}

export interface CleanupView {
  phase: CleanupPhase;
  rows: CleanupRowView[];
  /** How many emails the consent step would send, or the preview's check would send. */
  toCheck: number;
  /** The model that would check them, and the models to pick from. */
  model: ImportData['emailModels'];
  /** The emails were dragged into the chat, which counts as agreeing to the check. */
  agreed: boolean;
}

function stateOf(working: ImportWorking): CleanupState {
  const state = working.ext[NAME] as Partial<CleanupState> | undefined;
  return { ...state, rows: state?.rows ?? {} };
}

function withState(working: ImportWorking, state: CleanupState): ImportWorking {
  return { ...working, ext: { ...working.ext, [NAME]: state } };
}

type EmailRow = EmailBoardRow & { id: string };

function emailRows(data: ImportData): EmailRow[] {
  return newRows(data).filter(isEmailRow) as EmailRow[];
}

/** The email a row was read from, without its attachments' content, which the cleanup does not need. */
function itemOf(row: EmailRow): EmailImportItem {
  return {
    subject: row.subject, senderName: row.senderName, receivedDateTime: row.receivedDateTime, markdownBody: row.markdownBody,
    inlineImageMap: row.inlineImageMap, attachments: row.attachments, emlFilePath: row.emlFilePath,
  };
}

function blocksOf(row: EmailRow, rowState: RowState | undefined): DetectedBlock[] {
  return rowState?.blocks ?? row.patternBlocks ?? [];
}

function statusOf(row: EmailRow, rowState: RowState | undefined, state: CleanupState, data: ImportData): ModelStatus {
  if (rowState?.status) return rowState.status;
  // Without model access in this window there is nothing to ask.
  if ((row.patternBlocks ?? []).length > 0 || !row.markdownBody.trim() || !data.emailModels) return 'not-needed';
  if (isTooLongForModelCheck(row.markdownBody)) return 'too-long';
  return state.consent === 'declined' ? 'declined' : 'awaiting-consent';
}

function blockId(row: EmailRow, block: DetectedBlock): string {
  return `${row.id}:${block.kind}:${block.startLine}:${block.endLine}`;
}

/** The stage the cleanup is at: asking for consent, showing what it found, or finished. A batch with nothing to ask or show is finished at once. */
export function cleanupPhase(session: ImportSession): CleanupPhase {
  if (session.recipe.kind !== 'email') return 'done';
  const state = stateOf(session.working);
  if (state.decision) return 'done';
  const rows = emailRows(session.derived.data);
  if (!state.consent && rows.some(r => statusOf(r, state.rows[rowKeyOf(session.derived.data, r)], state, session.derived.data) === 'awaiting-consent')) return 'consent';
  const found = rows.some(r => {
    const rs = state.rows[rowKeyOf(session.derived.data, r)];
    return !rs?.excluded && blocksOf(r, rs).length > 0;
  });
  return found ? 'preview' : 'done';
}

/** The emails a check would send now: at consent the ones awaiting it, on the preview every one not excluded and not yet checked that fits the limit. */
function toCheck(session: ImportSession): EmailRow[] {
  const { data } = session.derived;
  const state = stateOf(session.working);
  const phase = cleanupPhase(session);
  return emailRows(data).filter(r => {
    const rs = state.rows[rowKeyOf(data, r)];
    const status = statusOf(r, rs, state, data);
    if (phase === 'consent') return status === 'awaiting-consent';
    return !rs?.excluded && status !== 'checked' && status !== 'too-long' && r.markdownBody.trim() !== '';
  });
}

function reduceCleanup(session: ImportSession, action: { type: string } & Record<string, unknown>): Reduced<ImportWorking> | undefined {
  if (!['cleanup-skip', 'cleanup-exclude', 'cleanup-strip', 'cleanup-keep'].includes(action.type)) return undefined;
  const phase = cleanupPhase(session);
  const { data } = session.derived;
  const state = stateOf(session.working);
  if (action.type === 'cleanup-skip') {
    if (phase !== 'consent') return { ok: false, reason: 'No email is waiting for the model check.' };
    return { ok: true, working: withState(session.working, { ...state, consent: 'declined' }) };
  }
  if (phase !== 'preview') return { ok: false, reason: 'There is no boilerplate to strip or keep now.' };
  if (action.type === 'cleanup-exclude') {
    const row = emailRows(data).find(r => r.id === action.id);
    if (!row || typeof action.excluded !== 'boolean') return { ok: false, reason: 'Pick an email of this import.' };
    const key = rowKeyOf(data, row);
    return { ok: true, working: withState(session.working, { ...state, rows: { ...state.rows, [key]: { ...state.rows[key], excluded: action.excluded } } }) };
  }
  if (action.type === 'cleanup-keep') return { ok: true, working: withState(session.working, { ...state, decision: 'keep' }) };
  const bodies: Record<string, EmailBodyChoice> = {};
  for (const row of emailRows(data)) {
    const key = rowKeyOf(data, row);
    const rs = state.rows[key];
    const blocks = blocksOf(row, rs);
    if (rs?.excluded || blocks.length === 0) continue;
    const cleaned = applyBoilerplateCleanup(itemOf(row), blocks);
    bodies[key] = { markdownBody: cleaned.item.markdownBody, droppedImages: cleaned.droppedImageNames };
  }
  return { ok: true, working: withState(session.working, { ...state, decision: 'strip', bodies }) };
}

function modelLabelOf(data: ImportData, id: string): string {
  return data.emailModels?.options?.find(m => m.id === id)?.label ?? id;
}

function planCleanup(session: ImportSession, action: { type: string } & Record<string, unknown>): Planned | undefined {
  if (action.type !== 'cleanup-check' && action.type !== 'cleanup-save') return undefined;
  const { data } = session.derived;
  const phase = cleanupPhase(session);

  if (action.type === 'cleanup-save') {
    if (phase !== 'preview') return { ok: false, reason: 'There is no boilerplate to save now.' };
    const state = stateOf(session.working);
    for (const row of emailRows(data)) {
      const key = rowKeyOf(data, row);
      const block = blocksOf(row, state.rows[key]).find(b => blockId(row, b) === action.block);
      if (!block) continue;
      if (block.source !== 'model') return { ok: false, reason: 'This block was found by one of your patterns, so it is saved already.' };
      const pattern = buildPatternFromBlock(row.markdownBody, block);
      if (!pattern) return { ok: false, reason: 'This block has no line to save as a pattern.' };
      const payload: CleanupPayload = { handler: NAME, op: 'save', key, block: action.block as string };
      const plan: WritePlan<CleanupPayload> = {
        title: 'Save a boilerplate pattern',
        lines: [{
          target: 'ticketSidekick.email.boilerplatePatterns',
          change: `Add a ${pattern.kind} pattern from "${pattern.start}"${pattern.end ? ` to "${pattern.end}"` : ''}`,
        }],
        risky: false,
        payload,
      };
      return { ok: true, plan };
    }
    return { ok: false, reason: 'That block is not in this cleanup.' };
  }

  if (phase === 'done') return { ok: false, reason: 'The email cleanup is finished.' };
  const rows = toCheck(session);
  if (rows.length === 0) return { ok: false, reason: 'Nothing left to check: every email was checked, is left out, or cannot be sent.' };
  const inUse = data.emailModels?.inUse?.id;
  const picked = typeof action.modelId === 'string' && action.modelId.trim() ? action.modelId.trim() : undefined;
  if (picked && !data.emailModels?.options?.some(m => m.id === picked)) return { ok: false, reason: 'That model is not available.' };
  const modelId = picked ?? inUse;
  if (!modelId) return { ok: false, reason: 'Pick the model that checks the emails first.' };
  const save = picked !== undefined && picked !== data.emailModels?.inUse?.id;
  const label = modelLabelOf(data, modelId);
  const payload: CleanupPayload = { handler: NAME, op: 'check', keys: rows.map(r => rowKeyOf(data, r)), modelId, save };
  const plan: WritePlan<CleanupPayload> = {
    title: `Check ${rows.length === 1 ? '1 email' : `${rows.length} emails`} for boilerplate with ${label}`,
    lines: [
      ...rows.map(r => ({ target: path.basename(r.emlFilePath), change: `Send the text of "${r.subject}" to ${label}` })),
      ...(save ? [{ target: EMAIL_MODEL_SETTING, change: `Save ${label} as the model of the email check` }] : []),
    ],
    risky: false,
    payload,
  };
  return { ok: true, plan };
}

/** One email's check: the model proposes blocks, and only quotes that really occur in the email are kept. Logs metadata only. */
async function checkOne(row: EmailRow, modelId: string, deps: ImportDeps): Promise<{ blocks: DetectedBlock[] } | { failed: string }> {
  const models = deps.models!;
  const body = row.markdownBody;
  let attempts = 0;
  let replyLength = 0;
  try {
    const proposals = await withLmRetry(async () => {
      attempts++;
      const reply = await models.send(modelId, buildModelCheckPrompt(body));
      replyLength = reply.length;
      if (!/[[{]/.test(reply)) throw new UnparseableReplyError(reply);
      return parseModelCheckReply(reply);
    });
    const blocks = verifyModelBlocks(body, proposals, deps.boilerplatePatterns?.() ?? [], row.senderName);
    deps.onDiag?.('info', 'Email model check done', { modelId, attempts, proposals: proposals.length, verifiedBlocks: blocks.length, replyLength, bodyLength: body.length });
    return { blocks };
  } catch (err) {
    const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : undefined;
    deps.onDiag?.('warn', 'Email model check failed', {
      modelId, errorCode: code, errorName: err instanceof Error ? err.name : typeof err, attempts, replyLength, bodyLength: body.length,
    });
    return { failed: err instanceof Error ? err.message : String(err) };
  }
}

async function applyCleanup(
  session: ImportSession, plan: WritePlan, deps: ImportDeps, progress?: ApplyProgress<ImportWorking>,
): Promise<Applied<ImportData, ImportWorking>> {
  const payload = plan.payload as CleanupPayload;
  const { data } = session.derived;
  let working = session.working;
  const results: ApplyLineResult[] = [];

  if (payload.op === 'save') {
    const state = stateOf(working);
    const row = emailRows(data).find(r => rowKeyOf(data, r) === payload.key);
    const block = row ? blocksOf(row, state.rows[payload.key]).find(b => blockId(row, b) === payload.block) : undefined;
    const pattern = row && block ? buildPatternFromBlock(row.markdownBody, block) : undefined;
    if (!pattern || !deps.savePattern) {
      return { results: [{ target: 'ticketSidekick.email.boilerplatePatterns', outcome: 'refused', reason: 'That block is no longer in this cleanup.' }], derived: session.derived, working };
    }
    try {
      await deps.savePattern(pattern);
      working = withState(working, { ...state, saved: [...new Set([...(state.saved ?? []), payload.block])] });
      results.push({ target: 'ticketSidekick.email.boilerplatePatterns', outcome: 'done' });
    } catch (err) {
      results.push({ target: 'ticketSidekick.email.boilerplatePatterns', outcome: 'failed', reason: err instanceof Error ? err.message : String(err) });
    }
    return { results, derived: session.derived, working };
  }

  if (!deps.models) {
    return { results: [{ target: payload.modelId, outcome: 'refused', reason: 'No language model can be called in this window.' }], derived: session.derived, working };
  }
  let derived = session.derived;
  if (payload.save && deps.modelSettings) {
    await deps.modelSettings.writeEmailModel(payload.modelId);
    const label = modelLabelOf(data, payload.modelId);
    derived = { ...derived, data: { ...derived.data, emailModels: { ...derived.data.emailModels, inUse: { id: payload.modelId, label, source: 'email' } } } };
    deps.onDiag?.('info', 'Email check model setting saved', { setting: EMAIL_MODEL_SETTING, modelId: payload.modelId });
  }
  const rows = new Map(emailRows(data).map(r => [rowKeyOf(data, r), r]));
  for (const [n, key] of payload.keys.entries()) {
    const row = rows.get(key);
    const target = row ? path.basename(row.emlFilePath) : path.basename(key);
    if (!row) {
      results.push({ target, outcome: 'refused', reason: 'This email is no longer in the import.' });
    } else {
      const outcome = await checkOne(row, payload.modelId, deps);
      const state = stateOf(working);
      const before = state.rows[key];
      const next: RowState = 'blocks' in outcome
        ? { ...before, blocks: outcome.blocks, status: 'checked', modelId: payload.modelId }
        : { ...before, status: 'failed', modelId: payload.modelId };
      working = withState(working, { ...state, rows: { ...state.rows, [key]: next } });
      results.push('blocks' in outcome
        ? { target, outcome: 'done', reason: outcome.blocks.length > 0 ? `${outcome.blocks.length} block(s) found` : 'nothing found' }
        : { target, outcome: 'failed', reason: outcome.failed });
    }
    await progress?.({ working, done: n + 1, total: payload.keys.length });
  }
  // Every email that was awaiting the answer has been checked or has failed now; the stage moves on.
  working = withState(working, { ...stateOf(working), consent: stateOf(working).consent ?? 'given' });
  return { results, derived, working };
}

export const cleanupStageHandler: ImportHandler = {
  name: NAME,
  reduce: reduceCleanup,
  plan: planCleanup,
  apply: applyCleanup,
  blocksPlans: session => (cleanupPhase(session) === 'done' ? undefined : FINISH_FIRST),
  unfinished: (session, tab) => tab === 'new' && cleanupPhase(session) !== 'done' && Object.keys(stateOf(session.working).rows).length > 0,
  hasWork: (session, tab) => tab === 'new' && cleanupPhase(session) !== 'done',
  view: (session, tab) => {
    if (tab !== 'new' || session.recipe.kind !== 'email') return undefined;
    const { data } = session.derived;
    const state = stateOf(session.working);
    const saved = new Set(state.saved ?? []);
    const view: CleanupView = {
      phase: cleanupPhase(session),
      toCheck: cleanupPhase(session) === 'done' ? 0 : toCheck(session).length,
      model: data.emailModels,
      agreed: session.recipe.emailConsent === true,
      rows: emailRows(data).map(row => {
        const rs = state.rows[rowKeyOf(data, row)];
        return {
          id: row.id, ref: path.basename(row.emlFilePath), subject: row.subject, status: statusOf(row, rs, state, data),
          ...(rs?.modelId ? { modelId: rs.modelId } : {}), excluded: rs?.excluded === true,
          blocks: blocksOf(row, rs).map(b => ({
            id: blockId(row, b), kind: b.kind, source: b.source, excerpt: b.excerpt, lines: b.nonEmptyLineCount,
            saved: saved.has(blockId(row, b)), savable: b.source === 'model' && !saved.has(blockId(row, b)),
          })),
        };
      }),
    };
    return view;
  },
};
