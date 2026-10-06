import { describe, it, expect } from 'vitest';
import { buildGuidedTransitionStatusOptions, parseGuidedTransitionStatusPick, findGuidedDirectTransition, parseGuidedTransitionPathPick, formatTransitionPathOption, parseGuidedTransitionResolutionPick, buildGuidedTransitionConfirmSummary, computeCommonTransitionStatuses } from '../participant/sessionState';
import type { JiraTransition } from '../jira/IJiraClient';
import type { CachedTransition, WorkflowGraph } from '../services/WorkflowService';

// R2/F1/U2: guided single-ticket transition flow's pure helpers. JiraParticipant.ts's
// continueGuidedTransition() (the vscode-dependent glue that stitches these into a multi-turn
// session) is only covered by the e2e suite — see sessionState.ts's own module doc comment.
describe('buildGuidedTransitionStatusOptions', () => {
  it('lists direct transition targets in order when there is no cached workflow graph', () => {
    const direct = [{ to: { name: 'In Progress' } }, { to: { name: 'Blocked' } }];

    expect(buildGuidedTransitionStatusOptions(direct, undefined, 'To Do')).toEqual(['In Progress', 'Blocked']);
  });

  it('includes AE1: a target reachable only via 2 hops, sourced from the cached graph', () => {
    const direct = [{ to: { name: 'Blocked' } }];
    const graph: WorkflowGraph = {
      'In Progress': [{ id: '1', name: 'Review', to: 'In Review' }],
      'In Review': [{ id: '2', name: 'Approve', to: 'Done' }],
    };

    const options = buildGuidedTransitionStatusOptions(direct, graph, 'In Progress');

    expect(options).toContain('Blocked');
    expect(options).toContain('Done'); // only reachable in 2 hops via the graph, not a direct target
    expect(options).toContain('In Review');
  });

  it('excludes the current status and never lists a status twice', () => {
    const direct = [{ to: { name: 'Done' } }];
    const graph: WorkflowGraph = { 'In Progress': [{ id: '1', name: 'Finish', to: 'Done' }] };

    const options = buildGuidedTransitionStatusOptions(direct, graph, 'In Progress');

    expect(options.filter((s) => s === 'Done').length).toBe(1);
    expect(options).not.toContain('In Progress');
  });
});

describe('parseGuidedTransitionStatusPick', () => {
  const options = ['In Progress', 'Blocked', 'Done'];

  it('matches by 1-based number', () => {
    expect(parseGuidedTransitionStatusPick('2', options)).toBe('Blocked');
  });

  it('matches by case-insensitive name', () => {
    expect(parseGuidedTransitionStatusPick('done', options)).toBe('Done');
  });

  it('recognizes an explicit cancellation', () => {
    expect(parseGuidedTransitionStatusPick('cancel', options)).toBe('cancel');
  });

  it('picks a status whose name is also a cancel word instead of cancelling', () => {
    const withCancelled = [...options, 'Cancelled'];
    expect(parseGuidedTransitionStatusPick('Cancelled', withCancelled)).toBe('Cancelled');
    expect(parseGuidedTransitionStatusPick('cancelled', withCancelled)).toBe('Cancelled');
    expect(parseGuidedTransitionStatusPick('cancel', withCancelled)).toBe('cancel');
  });

  it('reports an unmatched reply as invalid (KTD6) rather than guessing', () => {
    expect(parseGuidedTransitionStatusPick('Nonexistent Status', options)).toBe('invalid');
  });
});

describe('findGuidedDirectTransition', () => {
  const transitions: JiraTransition[] = [
    { id: '11', name: 'Start Progress', to: { name: 'In Progress' } },
    { id: '31', name: 'Close', to: { name: 'Done' }, fields: { resolution: { required: true, allowedValues: [{ name: 'Fixed' }] } } },
  ];

  it('finds a direct transition case-insensitively by target status name', () => {
    expect(findGuidedDirectTransition(transitions, 'done')?.id).toBe('31');
  });

  it('returns undefined when no direct transition matches', () => {
    expect(findGuidedDirectTransition(transitions, 'Blocked')).toBeUndefined();
  });
});

// U6/R9: multi-ticket transition chip's status intersection. The status-pick parser itself is
// `parseGuidedTransitionStatusPick` (reused verbatim, already covered above) — nothing new to
// test there.
describe('computeCommonTransitionStatuses', () => {
  it('returns the intersection when two tickets have overlapping transitions', () => {
    const result = computeCommonTransitionStatuses([
      ['In Progress', 'Blocked', 'Done'],
      ['Done', 'Blocked'],
    ]);

    expect(result.sort()).toEqual(['Blocked', 'Done']);
  });

  it('returns an empty array when two tickets have no common transition', () => {
    const result = computeCommonTransitionStatuses([
      ['In Progress'],
      ['Done'],
    ]);

    expect(result).toEqual([]);
  });

  it('de-duplicates a single ticket\'s own repeated transition target', () => {
    const result = computeCommonTransitionStatuses([
      ['Done', 'Done'],
      ['Done'],
    ]);

    expect(result).toEqual(['Done']);
  });

  it('returns an empty array for empty input', () => {
    expect(computeCommonTransitionStatuses([])).toEqual([]);
  });
});

describe('parseGuidedTransitionPathPick', () => {
  it('matches a valid 1-based number within range', () => {
    expect(parseGuidedTransitionPathPick('2', 3)).toBe(2);
  });

  it('rejects a number out of range as invalid', () => {
    expect(parseGuidedTransitionPathPick('4', 3)).toBe('invalid');
  });

  it('rejects non-numeric text as invalid (KTD6)', () => {
    expect(parseGuidedTransitionPathPick('the second one', 3)).toBe('invalid');
  });

  it('recognizes an explicit cancellation', () => {
    expect(parseGuidedTransitionPathPick('cancel', 3)).toBe('cancel');
  });
});

describe('formatTransitionPathOption', () => {
  it('formats a single-hop path with singular "hop"', () => {
    const path: CachedTransition[] = [{ id: '1', name: 'Finish', to: 'Done' }];
    expect(formatTransitionPathOption('In Progress', path)).toBe('In Progress → Done (1 hop)');
  });

  it('formats a multi-hop path with plural "hops", prepending currentStatus', () => {
    const path: CachedTransition[] = [
      { id: '1', name: 'Review', to: 'In Review' },
      { id: '2', name: 'Approve', to: 'Done' },
    ];
    expect(formatTransitionPathOption('In Progress', path)).toBe('In Progress → In Review → Done (2 hops)');
  });

  it('covers AE1: two equal-length paths through different intermediates render as distinct labels', () => {
    const viaQa: CachedTransition[] = [
      { id: '1', name: 'To QA', to: 'QA' },
      { id: '2', name: 'Approve', to: 'Done' },
    ];
    const viaReview: CachedTransition[] = [
      { id: '3', name: 'To Review', to: 'In Review' },
      { id: '4', name: 'Approve', to: 'Done' },
    ];

    const labelA = formatTransitionPathOption('In Progress', viaQa);
    const labelB = formatTransitionPathOption('In Progress', viaReview);

    expect(labelA).toBe('In Progress → QA → Done (2 hops)');
    expect(labelB).toBe('In Progress → In Review → Done (2 hops)');
    expect(labelA).not.toBe(labelB);
  });
});

describe('parseGuidedTransitionResolutionPick', () => {
  const options = ['Fixed', 'Won\'t Fix'];

  it('matches by number', () => {
    expect(parseGuidedTransitionResolutionPick('1', options)).toBe('Fixed');
  });

  it('matches by case-insensitive name', () => {
    expect(parseGuidedTransitionResolutionPick("won't fix", options)).toBe("Won't Fix");
  });

  it('recognizes an explicit cancellation', () => {
    expect(parseGuidedTransitionResolutionPick('cancel', options)).toBe('cancel');
  });

  it('picks a resolution whose name is also a cancel word instead of cancelling', () => {
    const withCancelled = [...options, 'Cancelled'];
    expect(parseGuidedTransitionResolutionPick('Cancelled', withCancelled)).toBe('Cancelled');
    expect(parseGuidedTransitionResolutionPick('cancel', withCancelled)).toBe('cancel');
  });

  it('treats "none" as unmatched — this ask is only shown when a resolution is required', () => {
    expect(parseGuidedTransitionResolutionPick('none', options)).toBe('invalid');
  });
});

describe('buildGuidedTransitionConfirmSummary', () => {
  it('omits the path line for a direct (single-hop) transition', () => {
    const path: CachedTransition[] = [{ id: '1', name: 'Start', to: 'In Progress' }];
    const summary = buildGuidedTransitionConfirmSummary('PROJ-1', 'In Progress', undefined, path, 'To Do');

    expect(summary).toContain('PROJ-1');
    expect(summary).toContain('In Progress');
    expect(summary).not.toContain('Path:');
    expect(summary).not.toContain('Resolution:');
  });

  it('includes both the resolution and the multi-hop path when both are present', () => {
    const path: CachedTransition[] = [
      { id: '1', name: 'Review', to: 'In Review' },
      { id: '2', name: 'Close', to: 'Done' },
    ];
    const summary = buildGuidedTransitionConfirmSummary('PROJ-1', 'Done', 'Fixed', path, 'In Progress');

    expect(summary).toContain('Path: In Progress → In Review → Done (2 hops)');
    expect(summary).toContain('Resolution: **Fixed**');
  });
});
