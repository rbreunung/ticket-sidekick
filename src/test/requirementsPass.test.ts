import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runRequirementsPass, type RequirementsPassDeps, type RequirementsPassParams } from '../participant/bitbucket/requirementsPass';
import { PrReviewService } from '../services/PrReviewService';
import { MockBitbucketClient } from './mocks/MockBitbucketClient';
import type { BitbucketPR } from '../bitbucket/IBitbucketClient';
import type { RequirementsTicket } from '../utils/requirementsSource';

function reply(name: string, patch: Record<string, unknown> = {}): string {
  const base = JSON.parse(readFileSync(resolve(process.cwd(), 'src/test/fixtures', `requirements-reply-${name}.json`), 'utf-8')) as object;
  return JSON.stringify({ ...base, ...patch });
}

const pr: BitbucketPR = {
  id: 42, title: 'REQ-2 fix double charge', description: 'desc',
  author: { displayName: 'Jane', emailAddress: 'j@example.com' },
  targetBranch: 'main', fromCommitHash: 'abc123',
};
const ticket: RequirementsTicket = {
  ticketKey: 'REQ-2',
  source: { key: 'REQ-2', summary: 'Double charge', descriptionText: 'Customers are charged twice.', truncatedDescription: false, comments: [], omittedComments: 0, commentsUnavailable: false },
};
// The recorded replies ask for src/payments/client.ts, so it is deliberately not part of the diff.
const fileDiffs = [{ path: 'src/ui/Checkout.ts', diff: '@@ -0,0 +1 @@\n+export const Checkout = 1;\n' }];

function setup(replies: Array<string | Error>, overrides: Partial<RequirementsPassDeps> = {}) {
  const markdown: string[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const prompts: string[] = [];
  const queue = [...replies];
  const params: RequirementsPassParams = {
    pr, ticket, fileDiffs, service: new PrReviewService(new MockBitbucketClient()), runTag: 'tag', tokenBudget: 50_000,
    logReview: (level, message) => { logs.push({ level, message }); },
    stream: { markdown: (t) => { markdown.push(t); } },
  };
  const deps: RequirementsPassDeps = {
    callModel: async (prompt, _round, _diag, validate) => {
      prompts.push(prompt);
      const next = queue.shift();
      if (next === undefined) throw new Error('no scripted reply left');
      if (next instanceof Error) throw next;
      validate(next);
      return next;
    },
    fetchContextFiles: async (requested) => new Map(requested.map((p) => [p, `content of ${p}`])),
    isCancelled: () => false,
    ...overrides,
  };
  return { params, deps, markdown, logs, prompts };
}

describe('runRequirementsPass', () => {
  it('returns the coverage from one call when the model asks for no more files', async () => {
    const t = setup([reply('clean-spec')]);
    const coverage = await runRequirementsPass(t.params, t.deps);

    expect(coverage?.ticketKey).toBe('REQ-2');
    expect(coverage?.requirements.length).toBeGreaterThan(0);
    expect(t.prompts).toHaveLength(1);
  });

  it('makes one second call with the files the model asked for, and no third', async () => {
    const t = setup([reply('bug-comment-fix'), reply('bug-comment-fix', { additionalFilesNeeded: [] })]);
    await runRequirementsPass(t.params, t.deps);

    expect(t.prompts).toHaveLength(2);
    expect(t.prompts[1]).toContain('### Context file: src/payments/client.ts');
    expect(t.prompts[1]).toContain('content of src/payments/client.ts');
  });

  it('keeps the first answer, with a warning in the log, when fetching the extra files fails', async () => {
    const t = setup([reply('bug-comment-fix')], { fetchContextFiles: async () => { throw new Error('HTTP 500'); } });
    const coverage = await runRequirementsPass(t.params, t.deps);

    expect(coverage).toBeDefined();
    expect(t.markdown.join('')).not.toContain('could not be completed');
    expect(t.logs.some((l) => l.level === 'warn' && l.message.includes('keeping the first answer'))).toBe(true);
  });

  it('keeps the first answer when no extra file could be fetched at all', async () => {
    const t = setup([reply('bug-comment-fix')], { fetchContextFiles: async () => new Map() });
    const coverage = await runRequirementsPass(t.params, t.deps);

    expect(coverage).toBeDefined();
    expect(t.prompts).toHaveLength(1);
  });

  it('keeps the first answer when the second round fails', async () => {
    const t = setup([reply('bug-comment-fix'), new Error('provider failed')]);
    const coverage = await runRequirementsPass(t.params, t.deps);

    expect(coverage?.requirements.length).toBeGreaterThan(0);
    expect(t.markdown.join('')).not.toContain('could not be completed');
  });

  it('names the failure in one line and returns nothing when the first call fails', async () => {
    const t = setup([new Error('provider failed\nwith detail')]);
    const coverage = await runRequirementsPass(t.params, t.deps);

    expect(coverage).toBeUndefined();
    expect(t.markdown.join('')).toMatch(/requirements check could not be completed \(provider failed with detail\)/);
  });

  it('flattens links in a provider error before naming it in the notice', async () => {
    const t = setup([new Error('boom [x](https://evil.example) <https://evil.example>')]);
    await runRequirementsPass(t.params, t.deps);

    const notice = t.markdown.join('');
    expect(notice).toContain('could not be completed');
    expect(notice).not.toMatch(/https?:\/\//);
    expect(notice).not.toMatch(/\]\(/);
  });

  it('rethrows when the request was cancelled, with no notice, so the review ends like any other pass', async () => {
    const cancelled = new Error('Canceled');
    const t = setup([cancelled], { isCancelled: () => true });

    await expect(runRequirementsPass(t.params, t.deps)).rejects.toBe(cancelled);
    expect(t.markdown.join('')).not.toContain('could not be completed');
  });

  it('rethrows a cancellation during the extra-file round instead of keeping the first answer', async () => {
    const cancelled = new Error('Canceled');
    const t = setup([reply('bug-comment-fix')], { fetchContextFiles: async () => { throw cancelled; }, isCancelled: () => true });

    await expect(runRequirementsPass(t.params, t.deps)).rejects.toBe(cancelled);
  });

  it('counts files cut from a stored diff as not seen', async () => {
    const t = setup([reply('clean-spec')]);
    t.params.alreadyOmittedPaths = ['src/ui/Banner.ts'];
    const coverage = await runRequirementsPass(t.params, t.deps);

    expect(coverage?.unseenFileCount).toBe(1);
    expect(t.prompts[0]).toContain('NOT SHOWN');
  });
});
