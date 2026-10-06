import { describe, it, expect } from 'vitest';
import type { WorkflowGraph } from '../services/WorkflowService';
import { type ReviewRowBase } from '../participant/sessionState';
import { buildStaleGroupScreen, initImportViewState, type ReviewSession } from '../participant/sessionState';
import { buildStaleTargetOptions, formatStaleTargetOption, parseStaleTargetPick, parseStaleIssueTypePick, selectedStaleIssueTypes, staleTargetNeedsResolution, planStaleTransitions, type StaleTargetOption, type StaleTicketGroup } from '../participant/sessionState';
import { parseStaleTicketToggle, applyStaleTicketToggle, type ReviewSessionStale, type TransitionBatchTicket } from '../participant/sessionState';

// U6: Stale review section — toggle-reply parsing/application and the rendered table.
describe('Stale-ticket review section (U6)', () => {
  const dummyPath = [{ id: '1', name: 'Go', to: 'Done' }];

  function makeStaleTicket(key: string, included = false): TransitionBatchTicket {
    return {
      key, summary: `Summary for ${key}`, currentStatus: 'Open',
      transitionPath: dummyPath, subtasks: [], included,
    };
  }

  function makeStale(overrides: Partial<ReviewSessionStale> = {}): ReviewSessionStale {
    return {
      groups: [{ issueType: 'Bug', rules: [], graph: {}, tickets: [makeStaleTicket('PROJ-1')] }],
      ineligible: [],
      resolutionOptions: [],
      ...overrides,
    };
  }

  describe('parseStaleTicketToggle', () => {
    it('recognizes a full ticket-key reply naming an eligible stale ticket', () => {
      expect(parseStaleTicketToggle('PROJ-1', makeStale())).toEqual({ matched: ['PROJ-1'], remainder: '' });
    });

    it('is case-insensitive but returns the ticket\'s real-cased key', () => {
      expect(parseStaleTicketToggle('proj-1', makeStale())).toEqual({ matched: ['PROJ-1'], remainder: '' });
    });

    it('matches multiple ticket keys in one reply', () => {
      const stale = makeStale({
        groups: [{ issueType: 'Bug', rules: [], graph: {}, tickets: [makeStaleTicket('PROJ-1'), makeStaleTicket('PROJ-2')] }],
      });
      expect(parseStaleTicketToggle('PROJ-1 PROJ-2', stale)).toEqual({ matched: ['PROJ-1', 'PROJ-2'], remainder: '' });
    });

    // Code-review fix regression test: a reply mixing a stale-ticket-key token with other tokens
    // (row-id toggles, `post it`, ...) must preserve those other tokens in `remainder` rather than
    // silently discarding them — the caller re-parses `remainder` instead of returning immediately.
    it('preserves non-stale-key tokens as remainder for a mixed reply', () => {
      expect(parseStaleTicketToggle('PROJ-1 3 7', makeStale())).toEqual({ matched: ['PROJ-1'], remainder: '3 7' });
    });

    it('never matches a row-id token (bare numeric "2" or already-ticketed "A1") — disjoint vocabulary', () => {
      expect(parseStaleTicketToggle('2', makeStale())).toBeNull();
      expect(parseStaleTicketToggle('A1', makeStale())).toBeNull();
    });

    it('never matches U4\'s page-nav tokens', () => {
      expect(parseStaleTicketToggle('next', makeStale())).toBeNull();
      expect(parseStaleTicketToggle('prev', makeStale())).toBeNull();
      expect(parseStaleTicketToggle('page 2', makeStale())).toBeNull();
    });

    it('never matches an ineligible ticket\'s key — R4: not offered a toggle', () => {
      const stale = makeStale({
        groups: [],
        ineligible: [{ key: 'PROJ-9', summary: 'x', currentStatus: 'Open', note: 'no cleanup rule configured' }],
      });
      expect(parseStaleTicketToggle('PROJ-9', stale)).toBeNull();
    });

    it('returns null for an unrelated reply', () => {
      expect(parseStaleTicketToggle('post it', makeStale())).toBeNull();
      expect(parseStaleTicketToggle('cancel', makeStale())).toBeNull();
    });
  });

  describe('applyStaleTicketToggle', () => {
    it('flips included for the named ticket across groups', () => {
      const stale = makeStale();
      const toggled = applyStaleTicketToggle(stale, ['PROJ-1']);
      expect(toggled.groups[0].tickets[0].included).toBe(true);
      // Original untouched (pure).
      expect(stale.groups[0].tickets[0].included).toBe(false);
    });

    it('leaves tickets not named untouched', () => {
      const stale = makeStale({
        groups: [{ issueType: 'Bug', rules: [], graph: {}, tickets: [makeStaleTicket('PROJ-1'), makeStaleTicket('PROJ-2', true)] }],
      });
      const toggled = applyStaleTicketToggle(stale, ['PROJ-1']);
      expect(toggled.groups[0].tickets[0].included).toBe(true);
      expect(toggled.groups[0].tickets[1].included).toBe(true); // was already true, untouched
    });
  });

  describe('buildStaleGroupScreen', () => {
    function staleSession(stale: ReviewSessionStale): ReviewSession<ReviewRowBase> {
      return initImportViewState({
        projectKey: 'PROJ', issueType: 'Bug', templateName: null, additionalFields: {},
        allRows: [], rows: [], page: 0, schemaVersion: 6, staleTickets: stale,
      });
    }

    it('renders eligible tickets with a positive toggle link and the ineligible note for others', () => {
      const stale = makeStale({
        ineligible: [{ key: 'PROJ-9', summary: 'Old finding', currentStatus: 'Open', note: 'no cleanup rule configured for PROJ/Task' }],
      });
      const rendered = buildStaleGroupScreen(staleSession(stale), { itemNoun: 'item(s)' });
      expect(rendered).toContain('PROJ-1');
      expect(rendered).toContain('PROJ-9');
      expect(rendered).toContain('no cleanup rule configured for PROJ/Task');
      expect(rendered).toContain('Stale');
      expect(rendered).toContain('Close 0 tickets');
      expect(decodeURIComponent(rendered)).toContain('"@jira done"'); // stale is the only group
    });

    it('offers "Close N tickets" for selected tickets and shows closed ones without a toggle', () => {
      const stale = makeStale({
        groups: [{ issueType: 'Bug', rules: [], graph: {}, tickets: [makeStaleTicket('PROJ-1', true), makeStaleTicket('PROJ-2', true)] }],
        closedKeys: ['PROJ-2'],
      });
      const rendered = buildStaleGroupScreen(staleSession(stale), { itemNoun: 'item(s)' });
      expect(decodeURIComponent(rendered)).toContain('[Close 1 tickets]');
      const p2 = rendered.split('\n').find(l => l.includes('PROJ-2'))!;
      expect(p2).toContain('✓ closed');
      expect(decodeURIComponent(p2)).not.toContain('"@jira PROJ-2"');
    });

    it('shows each ticket\'s issue type, no fixed target, and says the target is picked next', () => {
      const stale = makeStale({
        groups: [{ issueType: 'Bug', rules: [], graph: {}, tickets: [makeStaleTicket('PROJ-1', true)] }],
      });
      const rendered = buildStaleGroupScreen(staleSession(stale), { itemNoun: 'item(s)' });
      expect(rendered).toContain('| Type |');
      expect(rendered).not.toContain('→ To');
      expect(rendered).toContain('you pick the target status next');
      expect(rendered).not.toContain('several issue types');
    });

    it('explains the one-issue-type-per-run rule when the selection spans several issue types (R12)', () => {
      const stale = makeStale({
        groups: [
          { issueType: 'Bug', rules: [], graph: {}, tickets: [makeStaleTicket('PROJ-1', true)] },
          { issueType: 'Vulnerability', rules: [], graph: {}, tickets: [makeStaleTicket('PROJ-2', true)] },
        ],
      });
      const rendered = buildStaleGroupScreen(staleSession(stale), { itemNoun: 'item(s)' });
      expect(rendered).toContain('each run closes one issue type');
    });
  });
});

// Stale-ticket target pick (docs/plans/2026-09-27-1949-feat-stale-ticket-target-pick-plan.md, U1).
describe('buildStaleTargetOptions', () => {
  const graph: WorkflowGraph = {
    'Open': [{ id: '1', name: 'Verify', to: 'Verification' }, { id: '2', name: 'Close', to: 'Done' }],
    'Verification': [{ id: '3', name: 'Accept', to: 'Done' }],
    'Reopened': [{ id: '4', name: 'Reject', to: 'Rejected' }],
  };

  it('lists matching rules first, labelled with their target, then reachable statuses alphabetically', () => {
    const options = buildStaleTargetOptions(
      [{ name: 'Close released bugs', targetState: 'Done', resolution: 'Fixed' }], graph, ['Open'],
    );

    expect(options.map(formatStaleTargetOption)).toEqual(['Close released bugs → Done', 'Done', 'Verification']);
    expect(options[0]).toEqual({ kind: 'rule', ruleName: 'Close released bugs', targetState: 'Done', resolution: 'Fixed' });
  });

  it('keeps a status that a rule also targets, since picking the plain status sets no rule resolution', () => {
    const options = buildStaleTargetOptions([{ name: 'Close', targetState: 'Done' }], graph, ['Open']);

    expect(options.filter(o => o.kind === 'status' && o.status === 'Done')).toHaveLength(1);
    expect(options.filter(o => o.kind === 'rule')).toHaveLength(1);
  });

  it('offers the union of statuses reachable from any selected ticket', () => {
    const options = buildStaleTargetOptions([], graph, ['Verification', 'Reopened', 'Verification']);

    expect(options.map(formatStaleTargetOption)).toEqual(['Done', 'Rejected']);
  });

  it('is empty when no rule matches and no selected ticket can reach anything', () => {
    expect(buildStaleTargetOptions([], graph, ['Done'])).toEqual([]);
  });
});

describe('parseStaleTargetPick', () => {
  const options: StaleTargetOption[] = [
    { kind: 'rule', ruleName: 'Close released bugs', targetState: 'Done', resolution: 'Fixed' },
    { kind: 'status', status: 'Done' },
    { kind: 'status', status: 'Verification' },
  ];

  it('picks by 1-based number', () => {
    expect(parseStaleTargetPick('3', options)).toEqual({ kind: 'status', status: 'Verification' });
  });

  it('picks a plain status by case-insensitive name, and a rule by its name', () => {
    expect(parseStaleTargetPick('done', options)).toEqual({ kind: 'status', status: 'Done' });
    expect(parseStaleTargetPick('close released bugs', options)).toEqual(options[0]);
  });

  it('treats back and cancellation words as going back', () => {
    expect(parseStaleTargetPick('back', options)).toBe('back');
    expect(parseStaleTargetPick('cancel', options)).toBe('back');
  });

  it('picks an offered status whose name is also a cancel word instead of going back', () => {
    const withCancelled: StaleTargetOption[] = [...options, { kind: 'status', status: 'Cancelled' }];
    expect(parseStaleTargetPick('Cancelled', withCancelled)).toEqual({ kind: 'status', status: 'Cancelled' });
    expect(parseStaleTargetPick('cancel', withCancelled)).toBe('back');
  });

  it('reports an unknown reply as invalid', () => {
    expect(parseStaleTargetPick('Archived', options)).toBe('invalid');
    expect(parseStaleTargetPick('9', options)).toBe('invalid');
  });
});

describe('parseStaleIssueTypePick', () => {
  const types = ['Bug', 'Vulnerability'];

  it('picks by number or case-insensitive name', () => {
    expect(parseStaleIssueTypePick('2', types)).toBe('Vulnerability');
    expect(parseStaleIssueTypePick('bug', types)).toBe('Bug');
  });

  it('picks an issue type whose name is also a cancel word instead of going back', () => {
    expect(parseStaleIssueTypePick('Stop', ['Bug', 'Stop'])).toBe('Stop');
  });

  it('goes back on back or cancel, and rejects an unknown type', () => {
    expect(parseStaleIssueTypePick('back', types)).toBe('back');
    expect(parseStaleIssueTypePick('cancel', types)).toBe('back');
    expect(parseStaleIssueTypePick('Story', types)).toBe('invalid');
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
