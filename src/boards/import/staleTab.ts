import { isFinalStatus } from '../../utils/finalStatus';
import type { Applied, ApplyProgress, Planned, Reduced } from '../../sessions/boardKind';
import type { ApplyLineResult, WritePlan } from '../../sessions/sessionTypes';
import type { ReportImportDescriptor } from '../../imports/descriptor';
import { buildStaleTargetOptions, runStaleClose } from '../../imports/staleClose';
import {
  planStaleTransitions, staleTargetNeedsResolution, staleTargetState,
  type ReviewRowBase, type ReviewSession, type ReviewSessionStale, type StaleTargetOption, type StaleTicketGroup,
} from '../../imports/types';
import { BATCH_LIMIT } from '../../utils/reportImport';
import type { HandlerPayload, ImportHandler, ImportSession } from './handlers';
import type { ImportWorking } from './kind';
import type { ImportData, ImportDeps, ImportRow } from './read';

// The import board's handler for the Stale tab: marking stale tickets and closing them by issue type.
// Each issue type of the marked tickets gets its own target (a matching cleanup rule, or a status
// reachable in its discovered workflow) and, for a closing status without a rule resolution, a
// resolution. One Apply moves every issue type that has what it needs, at most 50 tickets, through
// the shared stale close (src/imports/staleClose.ts). vscode-free.

const NAME = 'stale';
const NO_RESOLUTION = 'none';

/** What the Stale tab keeps: the picked target and resolution per issue type, by option id. */
interface StaleChoices {
  targets: Record<string, string>;
  resolutions: Record<string, string>;
}

interface StaleClosePayload extends HandlerPayload {
  groups: Array<{ issueType: string; targetState: string; resolution?: string; keys: string[] }>;
}

export interface StaleTargetOptionView {
  id: string;
  label: string;
  needsResolution: boolean;
}

export interface StaleGroupView {
  issueType: string;
  /** Selected tickets of this issue type the board has not moved yet. */
  selected: number;
  targetOptions: StaleTargetOptionView[];
  target: string | null;
  /** Offered only when the picked target closes the tickets and sets no resolution of its own. */
  resolutionOptions: Array<{ id: string; label: string }>;
  resolution: string | null;
  /** Why this group would be left out of a close now; absent when it is ready or has nothing selected. */
  missing?: string;
}

export interface StaleExtView {
  groups: StaleGroupView[];
  /** The tickets that can be marked: eligible ones the board has not moved yet. */
  selectable: string[];
}

function choicesOf(working: ImportWorking): StaleChoices {
  const stored = working.ext[NAME] as Partial<StaleChoices> | undefined;
  return { targets: { ...(stored?.targets ?? {}) }, resolutions: { ...(stored?.resolutions ?? {}) } };
}

function withChoices(working: ImportWorking, choices: StaleChoices): ImportWorking {
  return { ...working, ext: { ...working.ext, [NAME]: choices } };
}

const optionId = (o: StaleTargetOption) => (o.kind === 'rule' ? `rule:${o.ruleName}` : `status:${o.status}`);
const optionLabel = (o: StaleTargetOption) => (o.kind === 'rule' ? `${o.ruleName} → ${o.targetState}` : o.status);
const resolutionId = (name: string) => `resolution:${name}`;

function staleOf(data: ImportData): ReviewSessionStale | undefined {
  return data.staleFailed ? undefined : data.review.staleTickets;
}

/** Whether the board may still mark this ticket: eligible, not moved by the board or an earlier close. */
function isOpen(stale: ReviewSessionStale, working: ImportWorking, key: string): boolean {
  return !working.writes.tickets[key] && !(stale.closedKeys ?? []).includes(key);
}

function selectableKeys(data: ImportData, working: ImportWorking): string[] {
  const stale = staleOf(data);
  if (!stale) return [];
  return stale.groups.flatMap(g => g.tickets.map(t => t.key)).filter(key => isOpen(stale, working, key));
}

/** A group's tickets the developer marked and the board has not moved yet, in group order. */
function selectedIn(stale: ReviewSessionStale, group: StaleTicketGroup, working: ImportWorking) {
  const marked = new Set(working.choices.staleSelected);
  return group.tickets.filter(t => marked.has(t.key) && isOpen(stale, working, t.key));
}

/** The group as the engine sees it: the marked open tickets included, the rest not. */
function asSelected(stale: ReviewSessionStale, group: StaleTicketGroup, working: ImportWorking): StaleTicketGroup {
  const keys = new Set(selectedIn(stale, group, working).map(t => t.key));
  return { ...group, tickets: group.tickets.map(t => ({ ...t, included: keys.has(t.key) })) };
}

interface GroupState {
  group: StaleTicketGroup;
  options: StaleTargetOption[];
  target?: StaleTargetOption;
  needsResolution: boolean;
  /** undefined while not chosen; null for no resolution. */
  resolution?: string | null;
}

function groupState(stale: ReviewSessionStale, group: StaleTicketGroup, working: ImportWorking, choices: StaleChoices): GroupState {
  const options = buildStaleTargetOptions(group.rules, group.graph, selectedIn(stale, group, working).map(t => t.currentStatus));
  const target = options.find(o => optionId(o) === choices.targets[group.issueType]);
  const needsResolution = target !== undefined && staleTargetNeedsResolution(target, stale.resolutionOptions);
  let resolution: string | null | undefined;
  if (target && !needsResolution) resolution = target.kind === 'rule' ? target.resolution ?? null : null;
  else if (target) {
    const picked = choices.resolutions[group.issueType];
    if (picked === NO_RESOLUTION) resolution = null;
    else if (picked !== undefined) resolution = stale.resolutionOptions.find(r => resolutionId(r) === picked);
  }
  return { group, options, ...(target ? { target } : {}), needsResolution, ...(resolution !== undefined ? { resolution } : {}) };
}

function missingOf(state: GroupState): string | undefined {
  if (!state.target) return 'no target status picked';
  if (state.resolution === undefined) return 'no resolution picked';
  return undefined;
}

function reduceStale(session: ImportSession, action: { type: string } & Record<string, unknown>): Reduced<ImportWorking> | undefined {
  const { working } = session;
  const { data } = session.derived;
  const stale = staleOf(data);
  if (action.type === 'toggle-stale') {
    if (!stale) return { ok: false, reason: 'The stale tickets are not available.' };
    const keys = Array.isArray(action.keys) ? action.keys.filter((k): k is string => typeof k === 'string') : [];
    if (keys.length === 0) return { ok: false, reason: 'Name the stale tickets to mark.' };
    const selectable = new Set(selectableKeys(data, working));
    const notSelectable = keys.find(key => !selectable.has(key));
    if (notSelectable !== undefined) {
      const ineligible = stale.ineligible.find(t => t.key === notSelectable);
      return { ok: false, reason: ineligible ? `${notSelectable} cannot be closed from the board: ${ineligible.note}.` : `${notSelectable} is not a stale ticket the board can close.` };
    }
    const flip = new Set(keys);
    const kept = working.choices.staleSelected.filter(key => !flip.has(key));
    const added = keys.filter((key, n) => !working.choices.staleSelected.includes(key) && keys.indexOf(key) === n);
    return { ok: true, working: { ...working, choices: { ...working.choices, staleSelected: [...kept, ...added] } } };
  }
  if (action.type === 'stale-target' || action.type === 'stale-resolution') {
    if (!stale) return { ok: false, reason: 'The stale tickets are not available.' };
    const group = stale.groups.find(g => g.issueType === action.issueType);
    if (!group) return { ok: false, reason: 'This import has no stale tickets of that issue type.' };
    const choices = choicesOf(working);
    if (action.type === 'stale-target') {
      if (action.target === null) {
        delete choices.targets[group.issueType];
        delete choices.resolutions[group.issueType];
        return { ok: true, working: withChoices(working, choices) };
      }
      const options = groupState(stale, group, working, choices).options;
      if (!options.some(o => optionId(o) === action.target)) return { ok: false, reason: `Pick one of the targets offered for ${group.issueType}.` };
      choices.targets[group.issueType] = action.target as string;
      delete choices.resolutions[group.issueType];
      return { ok: true, working: withChoices(working, choices) };
    }
    const state = groupState(stale, group, working, choices);
    if (!state.target || !state.needsResolution) return { ok: false, reason: `The target picked for ${group.issueType} asks for no resolution.` };
    const offered = [NO_RESOLUTION, ...stale.resolutionOptions.map(resolutionId)];
    if (!offered.includes(action.resolution as string)) return { ok: false, reason: `Pick one of the resolutions offered for ${group.issueType}.` };
    choices.resolutions[group.issueType] = action.resolution as string;
    return { ok: true, working: withChoices(working, choices) };
  }
  return undefined;
}

function planStale(session: ImportSession): Planned {
  const { working } = session;
  const stale = staleOf(session.derived.data);
  if (!stale) return { ok: false, reason: 'The stale tickets are not available.' };
  const choices = choicesOf(working);
  const states = stale.groups.map(g => groupState(stale, g, working, choices)).filter(s => selectedIn(stale, s.group, working).length > 0);
  if (states.length === 0) return { ok: false, reason: 'Mark at least one stale ticket to close.' };

  const leftOut: string[] = [];
  const lines: WritePlan['lines'] = [];
  const groups: StaleClosePayload['groups'] = [];
  let writes = 0;
  let remaining = 0;
  for (const state of states) {
    const missing = missingOf(state);
    if (missing) {
      leftOut.push(`${state.group.issueType}: ${missing}`);
      continue;
    }
    const targetState = staleTargetState(state.target!);
    const resolution = state.resolution ?? undefined;
    const { runnable, skipped } = planStaleTransitions(asSelected(stale, state.group, working), targetState, stale.closedKeys);
    const room = Math.max(0, BATCH_LIMIT - writes);
    const taken = runnable.slice(0, room);
    remaining += runnable.length - taken.length;
    writes += taken.length;
    if (taken.length === 0 && skipped.length === 0) continue;
    for (const t of taken) {
      lines.push({ target: t.key, change: `Status: ${t.currentStatus} → ${targetState}${resolution ? `, resolution ${resolution}` : ''}` });
    }
    for (const s of skipped) lines.push({ target: s.key, change: `Not moved: ${s.reason}` });
    groups.push({ issueType: state.group.issueType, targetState, ...(resolution ? { resolution } : {}), keys: [...taken.map(t => t.key), ...skipped.map(s => s.key)] });
  }
  if (groups.length === 0) {
    return { ok: false, reason: leftOut.length > 0 ? `Nothing can be closed yet. ${leftOut.join('; ')}.` : 'None of the marked tickets can be moved.' };
  }

  const where = groups.map(g => `${g.issueType} to ${g.targetState}`).join(', ');
  let title = `Move ${writes} stale ticket(s): ${where}.`;
  if (leftOut.length > 0) title += ` Not in this Apply: ${leftOut.join('; ')}.`;
  if (remaining > 0) title += ` ${remaining} selected ticket(s) remain for the next Apply.`;
  const payload: StaleClosePayload = { handler: NAME, groups };
  // A write to more than one ticket, or any close, also asks for VS Code's own confirmation.
  const closes = groups.some(g => isFinalStatus(g.targetState));
  return { ok: true, plan: { title, lines, risky: writes > 1 || closes, payload } };
}

async function applyStale(
  session: ImportSession, plan: WritePlan, deps: ImportDeps, progress?: ApplyProgress<ImportWorking>,
): Promise<Applied<ImportData, ImportWorking>> {
  const payload = plan.payload as StaleClosePayload;
  const { ticketService } = await deps.writeAccess();
  const descriptors = deps.descriptors();
  const descriptor = (session.recipe.kind === 'waltz' ? descriptors.waltz : descriptors.veracode) as unknown as ReportImportDescriptor<unknown, ImportRow>;
  const total = payload.groups.reduce((n, g) => n + g.keys.length, 0);
  const results: ApplyLineResult[] = [];
  let working = session.working;
  let review: ReviewSession<ImportRow> = session.derived.data.review;
  let done = 0;

  for (const planned of payload.groups) {
    for (const key of planned.keys) {
      const stale = review.staleTickets;
      const group = stale?.groups.find(g => g.issueType === planned.issueType);
      if (!stale || !group || !group.tickets.some(t => t.key === key) || !isOpen(stale, working, key)) {
        results.push({ target: key, outcome: 'refused', reason: 'It is no longer a stale ticket the board can close.' });
      } else {
        // One ticket at a time through the shared stale close, so each finished write is saved before the next.
        const one: ReviewSession<ImportRow> = {
          ...review,
          staleTickets: { ...stale, groups: stale.groups.map(g => (g !== group ? g : { ...g, tickets: g.tickets.map(t => ({ ...t, included: t.key === key })) })) },
        };
        const result = await runStaleClose<unknown, ImportRow>(one as ReviewSession<ImportRow & ReviewRowBase>, planned.issueType, planned.targetState, planned.resolution, ticketService, descriptor, { onDiag: deps.onDiag });
        review = { ...review, staleTickets: { ...stale, closedKeys: result!.session.staleTickets!.closedKeys } };
        const deselect = () => ({ ...working.choices, staleSelected: working.choices.staleSelected.filter(k => k !== key) });
        if (result!.transitioned.includes(key)) {
          let updated: string | undefined;
          try {
            updated = (await deps.updatedTimes([key]))[key];
          } catch (err) {
            deps.onDiag?.('warn', 'Import board: the update time after a stale close could not be read', { issueKey: key, error: err instanceof Error ? err.message : String(err) });
          }
          working = { ...working, choices: deselect(), writes: { ...working.writes, tickets: { ...working.writes.tickets, [key]: updated !== undefined ? { updated } : {} } } };
          results.push({ target: key, outcome: 'done' });
        } else {
          const skipped = result!.skipped.find(s => s.key === key);
          const failure = result!.failures.find(f => f.key === key);
          if (skipped) {
            working = { ...working, choices: deselect() };
            results.push({ target: key, outcome: 'refused', reason: `Not moved: ${skipped.reason}.` });
          } else {
            results.push({ target: key, outcome: 'failed', reason: failure?.reason ?? 'The transition failed.' });
          }
        }
      }
      done += 1;
      await progress?.({ working, done, total });
    }
  }
  return { results, derived: { ...session.derived, data: { ...session.derived.data, review } }, working };
}

function viewStale(session: ImportSession): StaleExtView | undefined {
  const { working } = session;
  const stale = staleOf(session.derived.data);
  if (!stale) return { groups: [], selectable: [] };
  const choices = choicesOf(working);
  const groups = stale.groups.map((g): StaleGroupView => {
    const state = groupState(stale, g, working, choices);
    const selected = selectedIn(stale, g, working).length;
    const missing = selected > 0 ? missingOf(state) : undefined;
    return {
      issueType: g.issueType,
      selected,
      targetOptions: state.options.map(o => ({ id: optionId(o), label: optionLabel(o), needsResolution: staleTargetNeedsResolution(o, stale.resolutionOptions) })),
      target: state.target ? optionId(state.target) : null,
      resolutionOptions: state.needsResolution
        ? [{ id: NO_RESOLUTION, label: 'None' }, ...stale.resolutionOptions.map(r => ({ id: resolutionId(r), label: r }))]
        : [],
      resolution: state.needsResolution && state.resolution !== undefined ? (state.resolution === null ? NO_RESOLUTION : resolutionId(state.resolution)) : null,
      ...(missing ? { missing } : {}),
    };
  });
  return { groups, selectable: selectableKeys(session.derived.data, working) };
}

export const staleTabHandler: ImportHandler = {
  name: NAME,
  reduce: reduceStale,
  plan: (session, action) => (action.type === 'close-stale' ? planStale(session) : undefined),
  apply: applyStale,
  view: (session, tab) => (tab === 'stale' ? viewStale(session) : undefined),
};
