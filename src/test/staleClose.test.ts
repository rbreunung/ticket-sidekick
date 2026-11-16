import { describe, it, expect } from 'vitest';
import type { WorkflowGraph } from '../services/WorkflowService';
import { buildStaleTargetOptions, type StaleTargetOption } from '../imports/staleClose';
import { selectedStaleIssueTypes, staleTargetNeedsResolution, planStaleTransitions, type StaleTicketGroup, type TransitionBatchTicket, type ReviewRowBase } from '../imports/types';

describe('buildStaleTargetOptions', () => {
  const label = (o: StaleTargetOption): string => (o.kind === 'rule' ? `${o.ruleName} → ${o.targetState}` : o.status);
  const graph: WorkflowGraph = {
    'Open': [{ id: '1', name: 'Verify', to: 'Verification' }, { id: '2', name: 'Close', to: 'Done' }],
    'Verification': [{ id: '3', name: 'Accept', to: 'Done' }],
    'Reopened': [{ id: '4', name: 'Reject', to: 'Rejected' }],
  };

  it('lists matching rules first, labelled with their target, then reachable statuses alphabetically', () => {
    const options = buildStaleTargetOptions(
      [{ name: 'Close released bugs', targetState: 'Done', resolution: 'Fixed' }], graph, ['Open'],
    );

    expect(options.map(label)).toEqual(['Close released bugs → Done', 'Done', 'Verification']);
    expect(options[0]).toEqual({ kind: 'rule', ruleName: 'Close released bugs', targetState: 'Done', resolution: 'Fixed' });
  });

  it('keeps a status that a rule also targets, since picking the plain status sets no rule resolution', () => {
    const options = buildStaleTargetOptions([{ name: 'Close', targetState: 'Done' }], graph, ['Open']);

    expect(options.filter(o => o.kind === 'status' && o.status === 'Done')).toHaveLength(1);
    expect(options.filter(o => o.kind === 'rule')).toHaveLength(1);
  });

  it('offers the union of statuses reachable from any selected ticket', () => {
    const options = buildStaleTargetOptions([], graph, ['Verification', 'Reopened', 'Verification']);

    expect(options.map(label)).toEqual(['Done', 'Rejected']);
  });

  it('is empty when no rule matches and no selected ticket can reach anything', () => {
    expect(buildStaleTargetOptions([], graph, ['Done'])).toEqual([]);
  });
});

describe('selectedStaleIssueTypes', () => {
  const ticket = (key: string, included: boolean): TransitionBatchTicket => ({
    key, summary: key, currentStatus: 'Open', transitionPath: [], subtasks: [], included,
  });

  it('lists only issue types with a selected ticket not yet transitioned, in group order', () => {
    const stale: ReviewSessionStale = {
      groups: [
        { issueType: 'Bug', rules: [], graph: {}, tickets: [ticket('P-1', true)] },
        { issueType: 'Task', rules: [], graph: {}, tickets: [ticket('P-2', false)] },
        { issueType: 'Vulnerability', rules: [], graph: {}, tickets: [ticket('P-3', true)] },
      ],
      ineligible: [],
      resolutionOptions: [],
      closedKeys: ['P-3'],
    };
    expect(selectedStaleIssueTypes(stale)).toEqual(['Bug']);
  });
});

describe('staleTargetNeedsResolution (R3/R4/KTD5)', () => {
  const resolutions = ['Fixed', "Won't Do"];

  it('never asks for a rule that names its own resolution', () => {
    expect(staleTargetNeedsResolution({ kind: 'rule', ruleName: 'r', targetState: 'Done', resolution: 'Fixed' }, resolutions)).toBe(false);
  });

  it('asks for a closed-like target from a rule without a resolution or from a plain status', () => {
    expect(staleTargetNeedsResolution({ kind: 'rule', ruleName: 'r', targetState: 'Done' }, resolutions)).toBe(true);
    expect(staleTargetNeedsResolution({ kind: 'status', status: 'Closed' }, resolutions)).toBe(true);
  });

  it('never asks for a non-final status, or when the instance has no resolutions', () => {
    expect(staleTargetNeedsResolution({ kind: 'status', status: 'Verification' }, resolutions)).toBe(false);
    expect(staleTargetNeedsResolution({ kind: 'status', status: 'Done' }, [])).toBe(false);
  });
});

describe('planStaleTransitions (KTD2/R11)', () => {
  const graph: WorkflowGraph = {
    'Open': [{ id: '1', name: 'Verify', to: 'Verification' }],
    'Verification': [{ id: '2', name: 'Accept', to: 'Done' }],
  };
  const t = (key: string, currentStatus: string, included = true): TransitionBatchTicket => ({
    key, summary: key, currentStatus, transitionPath: [], subtasks: [], included,
  });

  it('builds a path from the stored graph for each selected ticket, multi-hop included', () => {
    const group: StaleTicketGroup = { issueType: 'Bug', rules: [], graph, tickets: [t('P-1', 'Open'), t('P-2', 'Open', false)] };
    const { runnable, skipped } = planStaleTransitions(group, 'Done');
    expect(runnable.map(r => r.key)).toEqual(['P-1']);
    expect(runnable[0].transitionPath.map(h => h.to)).toEqual(['Verification', 'Done']);
    expect(skipped).toEqual([]);
  });

  it('skips a ticket with no path, and one already in the target, with a reason each (AE5)', () => {
    const group: StaleTicketGroup = {
      issueType: 'Bug', rules: [], graph, tickets: [t('P-1', 'Open'), t('P-2', 'Done'), t('P-3', 'Verification')],
    };
    const { runnable, skipped } = planStaleTransitions(group, 'Verification');
    expect(runnable.map(r => r.key)).toEqual(['P-1']);
    expect(skipped).toEqual([
      { key: 'P-2', reason: 'no path found from Done to Verification in the discovered workflow' },
      { key: 'P-3', reason: 'already in Verification' },
    ]);
  });

  it('never plans a ticket that was already transitioned', () => {
    const group: StaleTicketGroup = { issueType: 'Bug', rules: [], graph, tickets: [t('P-1', 'Open')] };
    expect(planStaleTransitions(group, 'Done', ['P-1']).runnable).toEqual([]);
  });
});

// ── Email boilerplate cleanup step (U5, KTD8) ─────────────────────────────────────────────────────
