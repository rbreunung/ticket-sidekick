import { describe, it, expect } from 'vitest';
import {
  parseImportReviewReply, parseMergeRunReply, describeImportReplyVocabulary, buildImportOverview, buildTicketedGroupScreen,
  buildImportDoneSummary, formatTicketedRowResult, emptyImportOutcomes, IMPORT_COMMANDS,
  type ImportReplyContext, type ReviewSession, type ReviewRowBase, type ReviewTableColumn, type MergeRun, buildCloseMergePrompt,
} from '../participant/sessionState';

function ctx(over: Partial<ImportReplyContext> = {}): ImportReplyContext {
  return {
    singleGroup: false, groups: ['new', 'ticketed', 'stale'], newRowIds: ['1', '2', '3'],
    ticketedRows: [{ id: 'A1', allowedActions: ['update', 'rewrite', 'leave'] }, { id: 'A5', allowedActions: ['leave'] }],
    canFold: true, canAccept: true, canMergeTickets: true, mergedRowIds: [], ...over,
  };
}

describe('merge … into … on the overview and Already ticketed screens (R1, R3)', () => {
  it.each(['overview', 'ticketed'] as const)('"merge A5 A6 into A3" on %s asks for the confirmation, naming every side', (view) => {
    expect(parseImportReviewReply(view, 'merge A5 A6 into A3', ctx())).toEqual({ kind: 'mergeTicketsPrompt', sources: ['A5', 'A6'], target: 'A3' });
  });

  it('reads ticket keys, commas and any casing, and normalizes them to upper case', () => {
    expect(parseImportReviewReply('overview', 'Merge proj-15, A6 INTO proj-12', ctx()))
      .toEqual({ kind: 'mergeTicketsPrompt', sources: ['PROJ-15', 'A6'], target: 'PROJ-12' });
  });

  it('a trailing "confirm" is the confirming click: the same sides, now to be run', () => {
    expect(parseImportReviewReply('ticketed', 'merge A5 into A3 confirm', ctx()))
      .toEqual({ kind: 'mergeTickets', sources: ['A5'], target: 'A3' });
  });

  it.each(['merge', 'merge A5', 'merge A5 into', 'merge into A3', 'merge A5 into A3 A4'])('"%s" is invalid and shows the usage', (reply) => {
    const action = parseImportReviewReply('overview', reply, ctx());
    expect(action.kind).toBe('invalid');
    expect((action as { reason?: string }).reason).toContain('merge A5 A6 into A3');
  });

  it('does not take over an Already-ticketed row action', () => {
    expect(parseImportReviewReply('ticketed', 'A1 rewrite', ctx())).toEqual({ kind: 'setAction', id: 'A1', action: 'rewrite' });
  });

  it('is not offered when the importer cannot merge tickets (Veracode, email)', () => {
    expect(parseImportReviewReply('overview', 'merge A5 into A3', ctx({ canMergeTickets: false })).kind).toBe('invalid');
    expect(parseImportReviewReply('ticketed', 'merge A5 into A3', ctx({ canMergeTickets: false })).kind).toBe('invalid');
  });
});

describe('merge on the New and Stale screens (R2, AE4)', () => {
  it('"merge 2 4" still combines New rows', () => {
    expect(parseImportReviewReply('new', 'merge 2 3', ctx())).toEqual({ kind: 'merge', ids: ['2', '3'] });
  });

  it.each(['new', 'stale'] as const)('the ticket form on %s changes nothing and points to the overview', (view) => {
    const action = parseImportReviewReply(view, 'merge PROJ-12 into PROJ-40', ctx());
    expect(action.kind).toBe('invalid');
    expect((action as { reason?: string }).reason).toMatch(/overview/i);
  });
});

describe('reload report (R13)', () => {
  it('asks for the confirmation first, then runs', () => {
    expect(parseImportReviewReply('overview', 'reload report', ctx())).toEqual({ kind: 'reloadPrompt' });
    expect(parseImportReviewReply('overview', 'Reload Report confirm', ctx())).toEqual({ kind: 'reload' });
  });

  it('works on the only screen of a single-group import, and not on the screens of a multi-group one', () => {
    const single = ctx({ singleGroup: true, groups: ['ticketed'] });
    for (const view of ['new', 'ticketed', 'stale'] as const) {
      expect(parseImportReviewReply(view, 'reload report', single)).toEqual({ kind: 'reloadPrompt' });
      expect(parseImportReviewReply(view, 'reload report', ctx()).kind).toBe('invalid');
    }
  });

  it('is not offered to an importer that cannot reload', () => {
    expect(parseImportReviewReply('overview', 'reload report', ctx({ canMergeTickets: false })).kind).toBe('invalid');
  });

  it('uses words no other screen command uses', () => {
    const others = Object.entries(IMPORT_COMMANDS).filter(([k]) => k !== 'reload').map(([, v]) => v as string);
    expect(others).not.toContain(IMPORT_COMMANDS.reload);
  });
});

describe('replies a waiting merge reads (R7, R11)', () => {
  const run = (over: Partial<MergeRun>): MergeRun => ({ survivor: 'PROJ-12', sources: ['PROJ-15'], steps: [], ...over });

  it('after a failed step, retry and ignore, and cancel to stop here', () => {
    const r = run({ awaiting: 'decision' });
    expect(parseMergeRunReply('retry', r)).toEqual({ kind: 'retry' });
    expect(parseMergeRunReply('Ignore', r)).toEqual({ kind: 'ignore' });
    expect(parseMergeRunReply('cancel', r)).toEqual({ kind: 'cancel' });
    expect(parseMergeRunReply('banana', r)).toEqual({ kind: 'invalid' });
  });

  it('a confirmation word is not a decision', () => {
    expect(parseMergeRunReply('ok', run({ awaiting: 'decision' }))).toEqual({ kind: 'invalid' });
  });

  it('asking for a target: a number or a name picks it, back stops', () => {
    const options = [{ kind: 'status' as const, status: 'Closed' }, { kind: 'status' as const, status: 'Done' }];
    const r = run({ awaiting: 'target', closeTargetOptions: options });
    expect(parseMergeRunReply('2', r)).toEqual({ kind: 'target', option: options[1] });
    expect(parseMergeRunReply('closed', r)).toEqual({ kind: 'target', option: options[0] });
    expect(parseMergeRunReply('back', r)).toEqual({ kind: 'cancel' });
    expect(parseMergeRunReply('9', r)).toEqual({ kind: 'invalid' });
  });

  it('asking for a resolution: a number or name picks it and none sets no resolution', () => {
    const r = run({ awaiting: 'resolution', resolutionOptions: ['Fixed', 'Done'] });
    expect(parseMergeRunReply('2', r)).toEqual({ kind: 'resolution', resolution: 'Done' });
    expect(parseMergeRunReply('none', r)).toEqual({ kind: 'resolution', resolution: null });
    expect(parseMergeRunReply('cancel', r)).toEqual({ kind: 'cancel' });
  });
});

describe('vocabulary and screens', () => {
  interface R extends ReviewRowBase { label: string }
  const columns: ReviewTableColumn<R>[] = [{ header: 'Name', accessor: r => r.label }];
  const row = (id: string, existing: string | null = null): R => ({
    id, existingTicketKey: existing, included: existing === null, label: `row ${id}`,
    ...(existing ? { allowedActions: ['leave' as const], action: 'leave' as const, target: { key: existing, status: 'Open', resolved: false }, ticketKeys: [existing] } : {}),
  });
  const session = (over: Partial<ReviewSession<R>> = {}): ReviewSession<R> => {
    const allRows = [row('1'), row('A1', 'PROJ-1')];
    return { projectKey: 'PROJ', issueType: 'Task', templateName: null, additionalFields: {}, allRows, rows: allRows, page: 0, schemaVersion: 12, ...over };
  };
  const opts = { itemNoun: 'component(s)', canMergeTickets: true };

  it('the overview and ticketed hints mention the merge and the reload only for an importer that has them', () => {
    expect(describeImportReplyVocabulary('overview', ctx())).toContain('reload report');
    expect(describeImportReplyVocabulary('ticketed', ctx())).toContain('merge A5 into A3');
    expect(describeImportReplyVocabulary('ticketed', ctx({ canMergeTickets: false }))).not.toContain('merge');
  });

  it('the overview offers the reload, and says the screens are out of date when they are', () => {
    expect(buildImportOverview(session(), opts)).toContain('reload report');
    expect(buildImportOverview(session(), opts)).not.toMatch(/out of date/i);
    const stale = buildImportOverview(session({ outOfDate: true }), opts);
    expect(stale).toMatch(/out of date/i);
    expect(stale).toContain('reload report');
  });

  it('the overview offers no reload to an importer without it', () => {
    expect(buildImportOverview(session(), { itemNoun: 'flaw(s)' })).not.toContain('reload report');
  });

  it('the overview counts merged tickets and failed merges', () => {
    const outcomes = { ...emptyImportOutcomes(), merged: 2, mergeFailed: 1 };
    const text = buildImportOverview(session({ outcomes }), opts);
    expect(text).toContain('2 merged');
    expect(text).toContain('1 failed');
  });

  it('the Already ticketed screen explains the merge reply', () => {
    expect(buildTicketedGroupScreen(session(), columns, opts)).toContain('merge A2 A3 into A1');
  });

  it('the done summary lists merged tickets only when there are any', () => {
    expect(buildImportDoneSummary(emptyImportOutcomes())).not.toContain('merged');
    expect(buildImportDoneSummary({ ...emptyImportOutcomes(), merged: 2, mergeFailed: 1 })).toMatch(/2 merged.*1 failed/);
  });

  it('a merged row shows where its ticket went', () => {
    expect(formatTicketedRowResult({ status: 'done', action: 'merge', into: 'PROJ-12' })).toContain('merged into PROJ-12');
  });
});

describe('buildCloseMergePrompt (close mode confirmation)', () => {
  const survivor = { key: 'PROJ-1301', summary: 'XSS in Bar.java', status: 'Open' };
  const source = { key: 'PROJ-1190', summary: 'XSS in Bar.java', status: 'Open' };
  const base = { survivor, itemNoun: 'flaw', survivorLost: [] as string[], warnings: [] as string[] };

  it('Covers AE3: with nothing to move it says the kept ticket stays as it is', () => {
    const out = buildCloseMergePrompt({ ...base, sources: [{ ticket: source, movable: [], unlisted: [] }] });
    expect(out).toContain('### Merge 1 ticket into PROJ-1301');
    expect(out).toContain('PROJ-1190 has no flaws PROJ-1301 lacks, so PROJ-1301 stays as it is.');
    expect(out).toMatch(/merge(%20| )PROJ-1190(%20| )into(%20| )PROJ-1301(%20| )confirm/i);
    expect(out).toMatch(/nothing is written until/i);
  });

  it('Covers AE4: names the items that move and says the kept ticket is rebuilt from the report', () => {
    const out = buildCloseMergePrompt({ ...base, sources: [{ ticket: source, movable: ['4711', '4712'], unlisted: [] }] });
    expect(out).toContain('PROJ-1190 also records 2 flaws (4711, 4712)');
    expect(out).toContain('rebuilding its title, description and labels from the report');
  });

  it('Covers AE5: names items the report no longer lists and says they are not moved', () => {
    const out = buildCloseMergePrompt({ ...base, sources: [{ ticket: source, movable: [], unlisted: ['4690'] }] });
    expect(out).toContain('4690');
    expect(out).toMatch(/no longer in the report/);
    expect(out).toMatch(/named in the comment on PROJ-1190/);
  });

  it('warns when rebuilding the kept ticket will stop showing a flaw it records', () => {
    const out = buildCloseMergePrompt({ ...base, survivorLost: ['4500'], sources: [{ ticket: source, movable: ['4711'], unlisted: [] }] });
    expect(out).toMatch(/stop showing 4500/);
  });

  it('shows warnings, defuses Jira-sourced markup, and says "duplicate" nowhere', () => {
    const out = buildCloseMergePrompt({
      ...base, warnings: ['PROJ-1190 is already resolved.'],
      sources: [{ ticket: { ...source, summary: 'click [here](http://evil.example)' }, movable: [], unlisted: [] }],
    });
    expect(out).toContain('⚠ PROJ-1190 is already resolved.');
    expect(out).not.toContain('](http://evil.example)');
    expect(out.toLowerCase()).not.toContain('duplicate');
  });
});
