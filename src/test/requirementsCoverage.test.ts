import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  parseRequirementsReply,
  buildCoverage,
  renderCoverageMarkdown,
  renderCoverageText,
} from '../participant/bitbucket/requirementsCoverage';
import { UnparseableReplyError } from '../utils/lmRetry';

function reply(name: string): string {
  return readFileSync(resolve(process.cwd(), 'src/test/fixtures', `requirements-reply-${name}.json`), 'utf-8');
}

const PR_FILES = ['src/payments/client.ts', 'src/ui/Checkout.ts', 'src/ui/Banner.ts'];

describe('parseRequirementsReply', () => {
  it('reads a recorded reply for a bug whose fix was agreed in a comment', () => {
    const parsed = parseRequirementsReply(reply('bug-comment-fix'), PR_FILES);
    expect(parsed.requirements[0]).toMatchObject({ text: 'Add an idempotency key to the capture request', source: 'comment', status: 'met' });
    expect(parsed.additionalFilesNeeded).toEqual(['src/payments/client.ts']);
    expect(parsed.noClearRequirements).toBe(false);
  });

  it('reads a reply wrapped in a code fence, with prose around it, or pretty-printed', () => {
    const json = reply('clean-spec');
    expect(parseRequirementsReply('```json\n' + json + '\n```', PR_FILES).requirements).toHaveLength(3);
    expect(parseRequirementsReply('Here is the check:\n' + json + '\nHope that helps {really}.', PR_FILES).requirements).toHaveLength(3);
    expect(parseRequirementsReply(JSON.stringify(JSON.parse(json)), PR_FILES).requirements).toHaveLength(3);
  });

  it('turns an invalid status into unclear and an invalid source into inferred, and drops entries without text', () => {
    const raw = JSON.stringify({
      reading: 'r',
      requirements: [
        { text: 'A', source: 'wiki', status: 'done', evidence: 'e' },
        { source: 'comment', status: 'met', evidence: 'no text' },
      ],
    });
    const parsed = parseRequirementsReply(raw, PR_FILES);
    expect(parsed.requirements).toEqual([{ text: 'A', source: 'inferred', status: 'unclear', evidence: 'e' }]);
  });

  it('treats a no-clear-requirements reply as having no requirements and no out-of-scope list', () => {
    const raw = JSON.stringify({ reading: 'r', noClearRequirements: true, requirements: [{ text: 'x', source: 'inferred', status: 'met', evidence: '' }], outOfScope: [{ file: 'src/ui/Banner.ts', note: 'n' }] });
    const parsed = parseRequirementsReply(raw, PR_FILES);
    expect(parsed.noClearRequirements).toBe(true);
    expect(parsed.requirements).toEqual([]);
    expect(parsed.outOfScope).toEqual([]);
  });

  it('drops an out-of-scope entry that names a file outside the PR, and counts it', () => {
    const raw = JSON.stringify({ reading: 'r', requirements: [], outOfScope: [{ file: 'src/ui/Banner.ts', note: 'a' }, { file: 'elsewhere/x.ts', note: 'b' }] });
    const parsed = parseRequirementsReply(raw, PR_FILES);
    expect(parsed.outOfScope.map((o) => o.file)).toEqual(['src/ui/Banner.ts']);
    expect(parsed.droppedOutOfScope).toBe(1);
  });

  it('reports a reply cut off mid-object, prose, or an object with no requirements list as unreadable', () => {
    expect(() => parseRequirementsReply(reply('clean-spec').slice(0, 120), PR_FILES)).toThrow(UnparseableReplyError);
    expect(() => parseRequirementsReply('I could not do that.', PR_FILES)).toThrow(UnparseableReplyError);
    expect(() => parseRequirementsReply('{"reading":"r"}', PR_FILES)).toThrow(UnparseableReplyError);
    expect(() => parseRequirementsReply('', PR_FILES)).toThrow(UnparseableReplyError);
  });
});

describe('renderCoverageMarkdown', () => {
  const coverageOf = (name: string, extra: { unseenFileCount?: number; userGoal?: string } = {}) =>
    buildCoverage('PROJ-123', parseRequirementsReply(reply(name), PR_FILES), extra);

  it('shows a requirement agreed in a comment with its source (AE3)', () => {
    const md = renderCoverageMarkdown(coverageOf('bug-comment-fix'));
    expect(md).toContain('### Requirements coverage — PROJ-123');
    expect(md).toContain('How I read this ticket');
    expect(md).toMatch(/\| Add an idempotency key to the capture request \| comment \| ✅ met \|/);
    expect(md).toContain('❔ unclear');
    expect(md).toContain('src/ui/Checkout.ts');
  });

  it('says no clear requirements were found, with no table and no out-of-scope list (AE4)', () => {
    const md = renderCoverageMarkdown(coverageOf('empty'));
    expect(md).toContain('No clear requirements found');
    expect(md).not.toContain('| Requirement |');
    expect(md).not.toContain('Not accounted for');
  });

  it('flags a contradictory thread and states how many files were not seen', () => {
    const md = renderCoverageMarkdown(coverageOf('contradictory', { unseenFileCount: 3 }));
    expect(md).toContain('description says CSV');
    expect(md).toMatch(/3 files were not shown/);
  });

  it('names the stated goal when the block was redone from one', () => {
    const md = renderCoverageMarkdown(coverageOf('clean-spec', { userGoal: 'retries must never double charge' }));
    expect(md).toContain('Using your stated goal');
    expect(md).toContain('retries must never double charge');
  });

  it('renders hostile ticket-derived text inert and keeps each requirement on one table row', () => {
    const hostile = '[click](command:workbench.action.chat.open?%7B%7D) | **bold**\nsecond line';
    const coverage = buildCoverage('PROJ-123', parseRequirementsReply(JSON.stringify({
      reading: hostile,
      requirements: [{ text: hostile, source: 'comment', status: 'met', evidence: hostile }],
      outOfScope: [{ file: 'src/ui/Banner.ts', note: hostile }],
      conflict: hostile,
    }), PR_FILES), {});
    const md = renderCoverageMarkdown(coverage);
    expect(md).not.toMatch(/\]\(command:/);
    const rows = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Requirement') && !l.startsWith('| ---'));
    expect(rows).toHaveLength(1);
    expect(rows[0].split(' | ').length).toBe(4);
  });
});

describe('renderCoverageText', () => {
  it('is plain text with no markdown table, links or bold', () => {
    const coverage = buildCoverage('PROJ-123', parseRequirementsReply(JSON.stringify({
      reading: 'Reads [x](command:y) and **bold**',
      requirements: [{ text: 'Add key', source: 'comment', status: 'met', evidence: 'done\nreally' }],
      outOfScope: [{ file: 'src/ui/Banner.ts', note: 'extra' }],
    }), PR_FILES), {});
    const text = renderCoverageText(coverage);
    expect(text).toContain('Requirements coverage (PROJ-123)');
    expect(text).toContain('met — Add key (comment)');
    expect(text).not.toContain('|');
    expect(text).not.toContain('\n\n\n');
  });
});
