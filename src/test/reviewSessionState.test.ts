import { describe, it, expect } from 'vitest';
import {
  neutralizeMarkdownLinks,
  ALL_PERSONA_IDS,
  formatReviewForSharing,
  resolveFindingAnchors,
  dedupeFindings,
  type ReviewFinding,
  type ReviewSession,
} from '../review/reviewSessionState';
import { addFindings, emptyStore } from '../review/engine/findingStore';

describe('neutralizeMarkdownLinks', () => {
  it('replaces [ and ] with visually similar full-width brackets, leaving other characters untouched', () => {
    expect(neutralizeMarkdownLinks('[Click here](command:evil)')).toBe('［Click here］(command:evil)');
    expect(neutralizeMarkdownLinks('Normal PR title — nothing to escape')).toBe('Normal PR title — nothing to escape');
  });
});

describe('formatReviewForSharing (Copy for Teams)', () => {
  const PR_URL = 'https://bb.example.com/projects/PROJ/repos/app/pull-requests/42';

  function finding(id: number, severity: ReviewFinding['severity'], extra: Partial<ReviewFinding> = {}): ReviewFinding {
    return {
      id,
      file: `src/file${id}.ts`,
      line: 10 * id,
      severity,
      title: `Title ${id}`,
      description: `Description ${id}`,
      recommendation: `Recommendation ${id}`,
      confidence: 0.9,
      ...extra,
    };
  }

  function session(findings: ReviewFinding[], extra: Partial<ReviewSession> = {}): ReviewSession {
    return {
      prTitle: 'Fix login race',
      prUrl: PR_URL,
      project: 'PROJ',
      repo: 'app',
      prId: 42,
      findings,
      prAuthor: 'Jane Doe',
      prTargetBranch: 'main',
      ...extra,
    };
  }

  it('groups a whole review by severity under a header with the bare PR link', () => {
    const findings = [
      finding(1, 'warning'), finding(2, 'critical'), finding(3, 'warning'),
      finding(4, 'critical'), finding(5, 'warning'),
    ];

    const { text, copiedCount, totalCount } = formatReviewForSharing(session(findings));

    expect(copiedCount).toBe(5);
    expect(totalCount).toBe(5);
    const lines = text.split('\n');
    expect(lines[0]).toBe('PR #42 — Fix login race');
    expect(lines[1]).toBe('by Jane Doe → main · 5 findings');
    expect(lines[2]).toBe(PR_URL);
    expect(text).toContain('🔴 Critical (2)');
    expect(text).toContain('🟡 Warning (3)');
    expect(text).not.toContain('Suggestion');
    expect(text.indexOf('Critical (2)')).toBeLessThan(text.indexOf('Warning (3)'));
    expect(text).toContain('#2 🔴 src/file2.ts:L20 — Title 2');
    expect(text).toContain('Recommendation: Recommendation 2');
  });

  it('copies only the selected findings and says how many of the whole review they are', () => {
    const findings = [1, 2, 3, 4, 5, 6, 7].map((id) => finding(id, id === 1 ? 'critical' : 'suggestion'));

    const { text, copiedCount, totalCount } = formatReviewForSharing(session(findings), { targets: [3, 1] });

    expect(copiedCount).toBe(2);
    expect(totalCount).toBe(7);
    expect(text).toContain('2 of 7 findings');
    expect(text).toContain('🔴 Critical (1)');
    expect(text).toContain('🔵 Suggestion (1)');
    expect(text).toContain('Title 1');
    expect(text).toContain('Title 3');
    expect(text).not.toContain('Title 2');
  });

  it('marks a finding whose location could not be verified instead of showing a line', () => {
    const findings = [finding(1, 'warning', { line: undefined, locationUnverified: true })];

    const { text } = formatReviewForSharing(session(findings));

    expect(text).toContain('#1 🟡 src/file1.ts (location unverified) — Title 1');
    expect(text).not.toContain(':L');
  });

  it('marks findings below the confidence threshold, and only those', () => {
    const findings = [
      finding(1, 'warning', { confidence: 0.4 }),
      finding(2, 'warning', { confidence: 0.7 }),
      finding(3, 'warning', { confidence: undefined }),
    ];

    const { text } = formatReviewForSharing(session(findings), { confidenceThreshold: 0.7 });

    const block = (id: number) => text.split('\n\n').find((b) => b.startsWith(`#${id} `)) ?? '';
    expect(block(1)).toContain('(low confidence)');
    expect(block(2)).not.toContain('low confidence');
    expect(block(3)).not.toContain('low confidence');
  });

  it('shares a review without findings as the header plus "No issues found"', () => {
    const { text, copiedCount } = formatReviewForSharing(session([]));

    expect(copiedCount).toBe(0);
    expect(text).toContain('0 findings');
    expect(text).toContain('No issues found.');
    expect(text).not.toMatch(/Critical|Warning|Suggestion/);
  });

  it('adds no chat markup of its own and copies finding text verbatim', () => {
    const findings = [finding(1, 'critical', {
      title: 'Guard arr[i] | null access',
      recommendation: 'Use `escape()`\n\nthen   retry\u0007',
    })];

    const { text } = formatReviewForSharing(session(findings, { prTitle: 'Handle [draft] PRs' }));

    // No table rows, bold headings, command links, or the chat renderer's fullwidth brackets.
    expect(text).not.toMatch(/^\|/m);
    expect(text).not.toContain('**');
    expect(text).not.toContain('command:');
    expect(text).not.toContain('［');
    expect(text).not.toContain('\u0007');
    expect(text).toContain('PR #42 — Handle [draft] PRs');
    expect(text).toContain('— Guard arr[i] | null access');
    expect(text).toContain('Recommendation: Use `escape()` then retry');
  });

  it('keeps a multi-line recommendation on one line so each finding stays one block', () => {
    const findings = [finding(1, 'warning', { recommendation: 'First line.\r\nSecond line.' })];

    const { text } = formatReviewForSharing(session(findings));

    expect(text).toContain('Recommendation: First line. Second line.');
  });

  it('omits the author line for a session saved before author and branch were stored', () => {
    const { text } = formatReviewForSharing(session([finding(1, 'warning')], { prAuthor: undefined, prTargetBranch: undefined }));

    const lines = text.split('\n');
    expect(lines[0]).toBe('PR #42 — Fix login race');
    expect(lines[1]).toBe('1 finding');
    expect(text).not.toContain('by ');
  });

  it('lists higher-confidence findings first within a group, and findings without confidence last', () => {
    const findings = [
      finding(1, 'warning', { confidence: undefined }),
      finding(2, 'warning', { confidence: 0.5 }),
      finding(3, 'warning', { confidence: 0.95 }),
    ];

    const { text } = formatReviewForSharing(session(findings));

    const order = [3, 2, 1].map((id) => text.indexOf(`#${id} `));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe('the "against goal" mark on findings', () => {
  const diffs = [{ path: 'src/session.ts', diff: '@@ -1,1 +1,2 @@\n const a = 1;\n+const ttl = 0;' }];
  type Raw = Omit<ReviewFinding, 'id'> & { againstGoal?: unknown };
  const reply = (extra: Record<string, unknown> = {}): Raw => ({
    file: 'src/session.ts', line: 2, anchorCode: 'const ttl = 0;', severity: 'warning',
    title: 'Sessions never expire', description: 'TTL 0', recommendation: 'Use the configured TTL', ...extra,
  });

  it('keeps againstGoal on a reply finding after its anchor is resolved, when the prompt asked for it', () => {
    const { findings } = resolveFindingAnchors([reply({ againstGoal: true })], diffs, { keepAgainstGoal: true });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 2, provenance: 'new', againstGoal: true });
  });

  it('drops a stray againstGoal when no background asked for it, and any value other than true', () => {
    const stray = resolveFindingAnchors([reply({ againstGoal: true })], diffs).findings[0];
    expect(stray).not.toHaveProperty('againstGoal');
    const odd = resolveFindingAnchors([reply({ againstGoal: 'yes' })], diffs, { keepAgainstGoal: true }).findings[0];
    expect(odd).not.toHaveProperty('againstGoal');
  });

  it('merges two duplicate findings, one marked against goal, into one finding that keeps the mark, either way round', () => {
    const plain = { ...reply(), sources: ['general' as const] };
    const marked = { ...reply(), againstGoal: true as const, sources: ['security' as const] };
    for (const pair of [[plain, marked], [marked, plain]]) {
      const merged = dedupeFindings(resolveFindingAnchors(pair, diffs, { keepAgainstGoal: true }).findings);
      expect(merged).toHaveLength(1);
      expect(merged[0].againstGoal).toBe(true);
    }
  });

  it('keeps the mark when the marked copy is the unlocated one dropped for its located twin', () => {
    const located = { ...reply(), sources: ['general' as const] };
    const unlocated = { ...reply({ anchorCode: 'no such line' }), againstGoal: true as const, sources: ['general' as const] };
    const merged = dedupeFindings(resolveFindingAnchors([located, unlocated], diffs, { keepAgainstGoal: true }).findings);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ line: 2, againstGoal: true });
  });

  it('marks a numbered finding against goal when a later duplicate carries the mark', () => {
    const first = addFindings(emptyStore(), [{ ...resolveFindingAnchors([reply()], diffs).findings[0], sources: ['general'], batch: 0 }]);
    const later = addFindings(first.store, [{
      ...resolveFindingAnchors([reply({ againstGoal: true, description: 'Expiry is zero' })], diffs, { keepAgainstGoal: true }).findings[0],
      sources: ['security'], batch: 0,
    }]);
    expect(later.merged).toEqual([1]);
    expect(later.store.findings).toHaveLength(1);
    expect(later.store.findings[0]).toMatchObject({ id: 1, description: 'TTL 0', againstGoal: true });
  });
});
