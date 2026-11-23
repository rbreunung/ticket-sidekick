import { describe, it, expect } from 'vitest';
import {
  neutralizeMarkdownLinks,
  ALL_PERSONA_IDS,
  formatReviewForSharing,
  type ReviewFinding,
  type ReviewSession,
} from '../review/reviewSessionState';

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

describe('formatReviewForSharing with a requirements coverage section', () => {
  const PR_URL = 'https://bb.example.com/projects/PROJ/repos/app/pull-requests/42';
  const finding = (id: number): ReviewFinding => ({
    id, file: `src/file${id}.ts`, line: 10, severity: 'warning', title: `Title ${id}`, description: 'd', recommendation: `Rec ${id}`, confidence: 0.9,
  });
  const session = (findings: ReviewFinding[]): ReviewSession => ({
    prTitle: 'Fix login race', prUrl: PR_URL, project: 'PROJ', repo: 'app', prId: 42, findings, prAuthor: 'Jane', prTargetBranch: 'main',
  });
  const COVERAGE = 'Requirements coverage (PROJ-1)\nmet — Add key (comment)';

  it('puts the coverage after the header and before the severity groups when the whole review is copied', () => {
    const { text } = formatReviewForSharing(session([finding(1)]), { coverageText: COVERAGE });
    expect(text.indexOf(PR_URL)).toBeLessThan(text.indexOf('Requirements coverage (PROJ-1)'));
    expect(text.indexOf('Requirements coverage (PROJ-1)')).toBeLessThan(text.indexOf('🟡 Warning'));
  });

  it('keeps the coverage on a review with no findings', () => {
    const { text } = formatReviewForSharing(session([]), { coverageText: COVERAGE });
    expect(text).toContain('Requirements coverage (PROJ-1)');
    expect(text).toContain('No issues found.');
    expect(text.indexOf('Requirements coverage')).toBeLessThan(text.indexOf('No issues found.'));
  });

  it('leaves the coverage out when only some findings are copied', () => {
    const { text } = formatReviewForSharing(session([finding(1), finding(2)]), { targets: [2], coverageText: COVERAGE });
    expect(text).not.toContain('Requirements coverage');
    expect(text).toContain('Title 2');
  });

  it('is unchanged when there is no coverage', () => {
    const base = formatReviewForSharing(session([finding(1)]));
    expect(formatReviewForSharing(session([finding(1)]), { coverageText: undefined }).text).toBe(base.text);
    expect(base.text).not.toContain('Requirements coverage');
  });
});
