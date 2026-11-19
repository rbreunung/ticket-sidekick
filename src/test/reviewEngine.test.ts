import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ModelRequestCancelledError, type BoardModelHandle } from '../boards/boardModels';
import {
  recheckRequirements,
  runCritic,
  runExtraPass,
  runRegularPass,
  type EngineDeps,
  type EngineSettings,
  type RequirementsChoice,
  type StagedReview,
} from '../review/engine';
import type { RequirementsSourceResult } from '../services/TicketService';
import { MockBitbucketClient } from './mocks/MockBitbucketClient';

// Scenarios for the staged review engine: a PR whose files each land in their own batch, a scripted
// model that answers by what the prompt asks, and the Bitbucket mock as the file reader.

const REVIEWED_COMMIT = 'abc123def456abc123def456abc123def456abc1';
const TARGET = { project: 'PROJ', repo: 'app', prId: 42 };
/** A budget that puts each test file in a batch of its own and leaves room for one small context file. */
const ONE_FILE_PER_BATCH: EngineSettings = { modelContextTokens: 2000, contextBudgetRatio: 1 };
/** A budget that puts two test files in each batch. */
const TWO_FILES_PER_BATCH: EngineSettings = { modelContextTokens: 2300, contextBudgetRatio: 1 };

function codeLine(file: number, line: number): string {
  return `export const value${file}_${line} = compute(${line}); // keeps the diff long enough`;
}

function prDiff(fileCount: number): string {
  return Array.from({ length: fileCount }, (_, i) => {
    const n = i + 1;
    const lines = Array.from({ length: 16 }, (_, l) => `+${codeLine(n, l + 1)}`);
    return `diff --git a/src/f${n}.ts b/src/f${n}.ts\n--- a/src/f${n}.ts\n+++ b/src/f${n}.ts\n@@ -0,0 +1,16 @@\n${lines.join('\n')}\n`;
  }).join('');
}

interface FindingSpec {
  file: number;
  line: number;
  title: string;
  severity?: 'critical' | 'warning' | 'suggestion';
  confidence?: number;
  description?: string;
}

function findingLine(f: FindingSpec): string {
  return JSON.stringify({
    file: `src/f${f.file}.ts`, line: f.line, anchorCode: codeLine(f.file, f.line), severity: f.severity ?? 'warning',
    confidence: f.confidence ?? 0.8, title: f.title, description: f.description ?? `${f.title} described`, recommendation: `Fix ${f.title}`,
  });
}

/** A review reply: one finding per line, then the meta line unless `meta` is null. */
function reviewReply(findings: FindingSpec[], meta: { recommendedPersonas?: string[]; additionalFilesNeeded?: string[] } | null = {}): string {
  const lines = findings.map(findingLine);
  if (meta) lines.push(JSON.stringify({ additionalFilesNeeded: meta.additionalFilesNeeded ?? [], ...(meta.recommendedPersonas ? { recommendedPersonas: meta.recommendedPersonas } : {}) }));
  return lines.join('\n');
}

type PromptKind = 'regular' | 'regular-whole-files' | 'security' | 'performance' | 'reliability' | 'maintainability' | 'critic' | 'requirements';

function kindOf(prompt: string): PromptKind {
  if (prompt.startsWith('You are verifying the findings')) return 'critic';
  if (prompt.startsWith('You are checking whether a pull request')) return 'requirements';
  for (const lens of ['security', 'performance', 'reliability', 'maintainability'] as const) {
    if (prompt.includes(`through a ${lens} lens ONLY`)) return lens;
  }
  return prompt.includes('First-pass findings (numbered)') ? 'regular-whole-files' : 'regular';
}

function batchFileOf(prompt: string): number {
  const m = /### File: src\/f(\d+)\.ts/.exec(prompt);
  return m ? Number(m[1]) : 0;
}

interface Call { prompt: string; kind: PromptKind; file: number }

/** A model whose reply comes from `respond`; it refuses to answer under an aborted signal, as the real handle does. */
function scriptedModel(respond: (call: Call, index: number) => string | Promise<string>) {
  const calls: Call[] = [];
  const handle: BoardModelHandle = {
    id: 'test-model',
    maxInputTokens: 100_000,
    countTokens: async (text) => Math.ceil((typeof text === 'string' ? text : text.content).length / 4),
    sendRequest: async (messages, { signal }) => {
      if (signal.aborted) throw new ModelRequestCancelledError();
      const prompt = messages.map((m) => m.content).join('\n');
      const call = { prompt, kind: kindOf(prompt), file: batchFileOf(prompt) };
      calls.push(call);
      const text = await respond(call, calls.length - 1);
      return { text: (async function* () { yield text; })() };
    },
  };
  return { handle, calls };
}

function setup(options: {
  files: number;
  respond: (call: Call, index: number) => string | Promise<string>;
  readTicket?: (key: string) => Promise<RequirementsSourceResult>;
}) {
  const client = new MockBitbucketClient();
  client.rawDiff = prDiff(options.files);
  const model = scriptedModel(options.respond);
  const controller = new AbortController();
  const recorded: Array<{ modelId: string; input: number; output: number }> = [];
  const deps: EngineDeps = {
    model: model.handle,
    recordTokens: async (modelId, figures) => { recorded.push({ modelId, input: figures.input, output: figures.output }); },
    client,
    signal: controller.signal,
    sleep: async () => {},
    ...(options.readTicket ? { readTicket: options.readTicket } : {}),
  };
  return { client, calls: model.calls, controller, deps, recorded };
}

const none: RequirementsChoice = { kind: 'none' };

async function regular(t: ReturnType<typeof setup>, settings: EngineSettings = ONE_FILE_PER_BATCH, requirements: RequirementsChoice = none) {
  return runRegularPass({ target: TARGET, requirements, settings }, t.deps);
}

function requirementsReply(): string {
  return readFileSync(resolve(process.cwd(), 'src/test/fixtures/requirements-reply-clean-spec.json'), 'utf-8');
}

describe('regular pass: suggestion of extra passes', () => {
  it('suggests the union of the batches\' recommendations: security, then nothing, then security and performance', async () => {
    const recommended: Record<number, string[]> = { 1: ['security'], 2: [], 3: ['security', 'performance'] };
    const t = setup({ files: 3, respond: (c) => reviewReply([], { recommendedPersonas: recommended[c.file] }) });

    const result = await regular(t);

    expect(result.outcome.status).toBe('finished');
    expect(result.review!.snapshot.batches).toHaveLength(3);
    expect(result.review!.suggestion).toEqual({ kind: 'suggested', personas: ['security', 'performance'] });
    // Every batch's pass 1 is the standard review prompt asking for the recommendation.
    expect(t.calls.map((c) => c.kind)).toEqual(['regular', 'regular', 'regular']);
    for (const c of t.calls) {
      expect(c.prompt).toContain('Review the changes for:');
      expect(c.prompt).toContain('"recommendedPersonas"');
    }
  });

  it('says no extra pass is suggested when every batch recommends none', async () => {
    const t = setup({ files: 3, respond: () => reviewReply([], { recommendedPersonas: [] }) });

    const result = await regular(t);

    expect(result.review!.suggestion).toEqual({ kind: 'none-suggested' });
  });

  it('says there is no usable recommendation when no reply carries the meta line', async () => {
    const t = setup({ files: 3, respond: (c) => reviewReply([{ file: c.file, line: 2, title: 'Unchecked input' }], null) });

    const result = await regular(t);

    expect(result.review!.suggestion).toEqual({ kind: 'no-usable-recommendation' });
    expect(result.review!.store.findings).toHaveLength(3);
  });
});

describe('regular pass: findings, batches and the snapshot', () => {
  it('numbers the findings once, stores the reviewed commit and each batch\'s context file, and records the pass as run', async () => {
    const t = setup({
      files: 2,
      respond: (c) => {
        if (c.kind === 'regular' && c.file === 1) return reviewReply([{ file: 1, line: 3, title: 'Missing null check' }], { additionalFilesNeeded: ['src/ctx.ts'] });
        if (c.kind === 'regular-whole-files') return reviewReply([], { additionalFilesNeeded: [] });
        return reviewReply([{ file: 2, line: 5, title: 'Leaky handle' }]);
      },
    });
    t.client.fileContents.set('src/ctx.ts', 'export const ctx = 1;');

    const result = await regular(t);
    const review = result.review!;

    expect(review.snapshot.reviewedCommit).toBe(REVIEWED_COMMIT);
    expect(review.snapshot.batches.map((b) => b.contextPaths)).toEqual([['src/ctx.ts'], []]);
    expect(review.store.findings.map((f) => [f.id, f.title])).toEqual([[1, 'Missing null check'], [2, 'Leaky handle']]);
    expect(review.store.stepsRun).toEqual(['regular']);
    // Pass 2 saw the whole file and was asked to refine pass 1's findings.
    const pass2 = t.calls.find((c) => c.kind === 'regular-whole-files')!;
    expect(pass2.prompt).toContain('### Context file: src/ctx.ts');
    expect(t.client.getFileContentCalls.map((c) => c.commitHash)).toEqual([REVIEWED_COMMIT]);
    // Token usage is returned per pass and recorded per call.
    expect(result.outcome.tokens.calls).toBe(3);
    expect(t.recorded).toHaveLength(3);
    // The stored review is plain data.
    expect(JSON.parse(JSON.stringify(review))).toEqual(review);
  });

  it('keeps the other batches\' findings when one batch fails after its retries, and counts it as failed', async () => {
    const t = setup({
      files: 3,
      respond: (c) => {
        if (c.file === 2) throw Object.assign(new Error('provider hiccup'), { code: 'Unknown' });
        return reviewReply([{ file: c.file, line: 1, title: `Issue in f${c.file}` }]);
      },
    });

    const result = await regular(t);

    expect(result.outcome.status).toBe('finished');
    expect(result.outcome.batchesDone).toBe(3);
    expect(result.outcome.failedBatches).toBe(1);
    expect(result.outcome.notes.join('\n')).toContain('src/f2.ts');
    expect(result.review!.store.findings.map((f) => f.file)).toEqual(['src/f1.ts', 'src/f3.ts']);
    expect(t.calls.filter((c) => c.file === 2)).toHaveLength(3);
  });

  it('stops during batch 3\'s model call: no further call, no retry or split, and batch 3 is not finished and not failed', async () => {
    const t = setup({
      files: 8,
      respond: (c) => {
        if (c.file === 5) {
          t.controller.abort();
          throw new ModelRequestCancelledError();
        }
        return reviewReply([{ file: c.file, line: 1, title: `Issue in f${c.file}` }]);
      },
    });

    const result = await regular(t, TWO_FILES_PER_BATCH);

    expect(result.review!.snapshot.batches).toHaveLength(4);
    expect(t.calls).toHaveLength(3);
    expect(result.outcome).toMatchObject({ status: 'stopped', batchesDone: 2, batchesTotal: 4, failedBatches: 0 });
    expect(result.review!.store.findings.map((f) => f.file)).toEqual(['src/f1.ts', 'src/f3.ts']);
    expect(result.review!.store.stepsRun).toEqual([]);
  });

  it('stopped after 3 of 7 batches: keeps those 3 batches\' findings and names 3 of 7', async () => {
    const t = setup({ files: 7, respond: (c) => reviewReply([{ file: c.file, line: 2, title: `Issue in f${c.file}` }]) });
    t.deps.onProgress = (p) => { if (p.step === 'regular' && p.batchesDone === 3) t.controller.abort(); };

    const result = await regular(t);

    expect(result.outcome).toMatchObject({ status: 'stopped', batchesDone: 3, batchesTotal: 7 });
    expect(result.review!.store.findings.map((f) => f.id)).toEqual([1, 2, 3]);
    expect(t.calls).toHaveLength(3);
  });

  it('reports the review as it stands after each finished batch: after 3 of 7 it is the review a stop after 3 gives', async () => {
    const respond = (c: Call) => reviewReply([{ file: c.file, line: 2, title: `Issue in f${c.file}` }], { recommendedPersonas: c.file === 2 ? ['security'] : [] });
    const t = setup({ files: 7, respond });
    const partial = new Map<number, StagedReview>();
    t.deps.onProgress = (p) => { if (p.step === 'regular' && p.review) partial.set(p.batchesDone, p.review); };
    await regular(t);

    const stoppedRun = setup({ files: 7, respond });
    stoppedRun.deps.onProgress = (p) => { if (p.step === 'regular' && p.batchesDone === 3) stoppedRun.controller.abort(); };
    const stopped = (await regular(stoppedRun)).review!;

    expect([...partial.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const afterThree = partial.get(3)!;
    expect(afterThree.store.findings.map((f) => f.title)).toEqual(['Issue in f1', 'Issue in f2', 'Issue in f3']);
    expect(afterThree.store.stepsRun).toEqual([]);
    expect(afterThree.suggestion).toEqual({ kind: 'suggested', personas: ['security'] });
    expect(JSON.parse(JSON.stringify(afterThree))).toEqual(JSON.parse(JSON.stringify(stopped)));
  });
});

describe('regular pass: requirements check', () => {
  it('with source none makes no Jira call and no requirements call', async () => {
    const readTicket = vi.fn(async (): Promise<RequirementsSourceResult> => { throw new Error('should not be called'); });
    const t = setup({ files: 1, respond: () => reviewReply([]), readTicket });

    const result = await regular(t);

    expect(readTicket).not.toHaveBeenCalled();
    expect(t.calls.map((c) => c.kind)).toEqual(['regular']);
    expect(result.requirements).toEqual({ status: 'not-run' });
    expect(result.review!.coverage).toBeUndefined();
  });

  it('with a ticket reads it and checks the whole diff against it after the findings', async () => {
    const readTicket = vi.fn(async (key: string): Promise<RequirementsSourceResult> => ({
      ok: true,
      source: { key, summary: 'Retry failed captures', descriptionText: 'Retry three times.', truncatedDescription: false, comments: [], omittedComments: 0, commentsUnavailable: false },
    }));
    const t = setup({ files: 2, respond: (c) => (c.kind === 'requirements' ? requirementsReply() : reviewReply([])), readTicket });

    const result = await regular(t, ONE_FILE_PER_BATCH, { kind: 'ticket', key: 'PAY-7' });

    expect(readTicket).toHaveBeenCalledWith('PAY-7');
    expect(t.calls.map((c) => c.kind)).toEqual(['regular', 'regular', 'requirements']);
    const prompt = t.calls[2].prompt;
    expect(prompt).toContain('Retry three times.');
    expect(prompt).toContain('### File: src/f1.ts');
    expect(prompt).toContain('### File: src/f2.ts');
    expect(result.requirements).toEqual({ status: 'checked' });
    expect(result.review!.coverage?.ticketKey).toBe('PAY-7');
  });
});

/** A finished regular pass over two files: #1, #2 in f1 and #3 in f2, with f1's batch having read src/ctx.ts. */
async function reviewedTwoFiles(respondLater: (c: Call) => string) {
  let regularDone = false;
  const t = setup({
    files: 2,
    respond: (c) => {
      if (regularDone) return respondLater(c);
      if (c.kind === 'regular' && c.file === 1) {
        return reviewReply([
          { file: 1, line: 2, title: 'Unvalidated input', severity: 'warning' },
          { file: 1, line: 4, title: 'Magic number', severity: 'suggestion', confidence: 0.6, description: 'The regular pass wording' },
        ], { additionalFilesNeeded: ['src/ctx.ts'] });
      }
      if (c.kind === 'regular-whole-files') return reviewReply([], { additionalFilesNeeded: [] });
      return reviewReply([{ file: 2, line: 1, title: 'Swallowed error' }]);
    },
  });
  t.client.fileContents.set('src/ctx.ts', 'export const ctx = 1;');
  const result = await regular(t);
  regularDone = true;
  t.calls.length = 0;
  t.client.getFileContentCalls.length = 0;
  return { t, review: result.review! };
}

describe('extra passes', () => {
  it('a security pass run later re-reads the stored context file at the reviewed commit, not at a newer head', async () => {
    const { t, review } = await reviewedTwoFiles(() => reviewReply([]));
    t.client.prOverride = { fromCommitHash: 'f00d000000000000000000000000000000000000' };

    const result = await runExtraPass(review, 'security', ONE_FILE_PER_BATCH, t.deps);

    expect(result.outcome.status).toBe('finished');
    expect(t.client.getFileContentCalls).toEqual([{ project: 'PROJ', repo: 'app', path: 'src/ctx.ts', commitHash: REVIEWED_COMMIT }]);
    expect(t.calls.map((c) => c.kind)).toEqual(['security', 'security']);
    expect(t.calls[0].prompt).toContain('### Context file: src/ctx.ts');
    expect(t.calls[1].prompt).not.toContain('### Context file: src/ctx.ts');
    expect(result.review.store.stepsRun).toEqual(['regular', 'security']);
  });

  it('may ask for more files, which are read at the reviewed commit and kept for later passes', async () => {
    const { t, review } = await reviewedTwoFiles((c) => {
      if (c.kind === 'security' && c.file === 2 && !c.prompt.includes('First-pass findings')) return reviewReply([{ file: 2, line: 3, title: 'Token logged' }], { additionalFilesNeeded: ['src/auth.ts'] });
      return reviewReply([]);
    });
    t.client.fileContents.set('src/auth.ts', 'export const auth = 2;');

    const result = await runExtraPass(review, 'security', ONE_FILE_PER_BATCH, t.deps);

    const second = t.calls.find((c) => c.prompt.includes('First-pass findings'))!;
    expect(second.kind).toBe('security');
    expect(second.prompt).toContain('### Context file: src/auth.ts');
    expect(t.client.getFileContentCalls.every((c) => c.commitHash === REVIEWED_COMMIT)).toBe(true);
    expect(result.review.snapshot.batches[1].contextPaths).toEqual(['src/auth.ts']);
    expect(result.review.store.findings.map((f) => [f.id, f.title])).toContainEqual([4, 'Token logged']);
  });

  it('merges a critical security finding into #2 (a suggestion): #2 keeps its number and text, becomes critical, lists both sources and gains the corroboration bump', async () => {
    const { t, review } = await reviewedTwoFiles((c) => (c.kind === 'security' && c.file === 1
      ? reviewReply([{ file: 1, line: 4, title: 'Magic number', severity: 'critical', confidence: 0.8, description: 'The security wording' }])
      : reviewReply([])));

    const result = await runExtraPass(review, 'security', ONE_FILE_PER_BATCH, t.deps);

    const two = result.review.store.findings.find((f) => f.id === 2)!;
    expect(two).toMatchObject({ title: 'Magic number', description: 'The regular pass wording', severity: 'critical', sources: ['general', 'security'], confidence: 0.85 });
    expect(result.review.store.findings.map((f) => f.id)).toEqual([1, 2, 3]);
    expect(result.outcome.merged).toEqual([2]);
    expect(result.outcome.added).toEqual([]);
  });

  it('a stopped extra pass is not marked as run and keeps its finished batches\' findings', async () => {
    const { t, review } = await reviewedTwoFiles((c) => {
      if (c.file === 2) { t.controller.abort(); throw new ModelRequestCancelledError(); }
      return reviewReply([{ file: 1, line: 6, title: 'Timing leak' }]);
    });

    const result = await runExtraPass(review, 'security', ONE_FILE_PER_BATCH, t.deps);

    expect(result.outcome).toMatchObject({ status: 'stopped', batchesDone: 1, batchesTotal: 2, added: [4] });
    expect(result.review.store.stepsRun).toEqual(['regular']);
  });

  it('reports the review as it stands after each finished batch, the pass not marked as run until the end', async () => {
    const { t, review } = await reviewedTwoFiles((c) => reviewReply([{ file: c.file, line: 6, title: `Timing leak in f${c.file}` }]));
    const partial: StagedReview[] = [];
    t.deps.onProgress = (p) => { if (p.step === 'security' && p.review) partial.push(p.review); };

    const result = await runExtraPass(review, 'security', ONE_FILE_PER_BATCH, t.deps);

    expect(partial).toHaveLength(2);
    expect(partial[0].store.findings.map((f) => f.title)).toEqual(['Unvalidated input', 'Magic number', 'Swallowed error', 'Timing leak in f1']);
    expect(partial[0].store.stepsRun).toEqual(['regular']);
    expect(partial[1].store.findings.map((f) => f.id)).toEqual([1, 2, 3, 4, 5]);
    expect(result.review.store.stepsRun).toEqual(['regular', 'security']);
  });

  it('does not run when the reviewed commit can no longer be read', async () => {
    const { t, review } = await reviewedTwoFiles(() => reviewReply([{ file: 1, line: 6, title: 'Timing leak' }]));
    vi.spyOn(t.client, 'getFileContent').mockRejectedValue(new Error('404 commit not found'));

    const result = await runExtraPass(review, 'performance', ONE_FILE_PER_BATCH, t.deps);

    expect(t.calls).toHaveLength(0);
    expect(result.outcome).toMatchObject({ status: 'commit-unreadable', unreadablePath: 'src/ctx.ts' });
    expect(result.review).toBe(review);
  });
});

describe('critic', () => {
  it('makes no model call, removes nothing and reports the commit unreadable when a context file cannot be read', async () => {
    const { t, review } = await reviewedTwoFiles(() => '{"keep":[]}');
    vi.spyOn(t.client, 'getFileContent').mockRejectedValue(new Error('404 commit not found'));

    const result = await runCritic(review, [], ONE_FILE_PER_BATCH, t.deps);

    expect(t.calls).toHaveLength(0);
    expect(result.outcome.status).toBe('commit-unreadable');
    expect(result.review.store.findings.map((f) => f.id)).toEqual([1, 2, 3]);
    expect(result.review.store.criticChecked).toEqual([]);
  });

  it('removes a rejected finding nobody worked on, labels a rejected one that was explained, and leaves every other number alone', async () => {
    let regularDone = false;
    const t = setup({
      files: 1,
      respond: (c) => {
        if (!regularDone) return reviewReply([1, 3, 5, 7, 9].map((line) => ({ file: 1, line, title: `Finding on line ${line}` })));
        return '{"keep":[1,2,4],"additionalFilesNeeded":[]}';
      },
    });
    const review = (await regular(t)).review!;
    regularDone = true;

    const result = await runCritic(review, [3], ONE_FILE_PER_BATCH, t.deps);

    const critic = t.calls.filter((c) => c.kind === 'critic');
    expect(critic).toHaveLength(1);
    expect(critic[0].prompt).toContain('[5] (warning) src/f1.ts:L9 — Finding on line 9');
    const store = result.review.store;
    expect(store.findings.map((f) => f.id)).toEqual([1, 2, 3, 4]);
    expect(store.findings.find((f) => f.id === 3)!.probablyFalseAlarm).toBe(true);
    expect(store.findings.find((f) => f.id === 4)!.probablyFalseAlarm).toBeUndefined();
    expect(result.outcome).toMatchObject({ status: 'finished', removed: [5], labelled: [3] });
    expect(store.criticChecked).toEqual([1, 2, 3, 4, 5]);
    expect(store.stepsRun).toEqual(['regular', 'critic']);
    expect(store.nextNumber).toBe(6);
  });

  it('checks only the findings it has not checked yet', async () => {
    const { t, review } = await reviewedTwoFiles(() => '{"keep":[1]}');
    const checked: StagedReview = { ...review, store: { ...review.store, criticChecked: [1, 2] } };

    const result = await runCritic(checked, [], ONE_FILE_PER_BATCH, t.deps);

    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].prompt).toContain('Swallowed error');
    expect(t.calls[0].prompt).not.toContain('Magic number');
    expect(result.review.store.findings.map((f) => f.id)).toEqual([1, 2, 3]);
  });

  it('reports the review as it stands after each finished batch: the verdicts of the batches done', async () => {
    const { t, review } = await reviewedTwoFiles(() => '{"keep":[]}');
    const partial: StagedReview[] = [];
    t.deps.onProgress = (p) => { if (p.step === 'critic' && p.review) partial.push(p.review); };

    await runCritic(review, [], ONE_FILE_PER_BATCH, t.deps);

    expect(partial).toHaveLength(2);
    expect(partial[0].store.findings.map((f) => f.id)).toEqual([3]);
    expect(partial[0].store.criticChecked).toEqual([1, 2]);
    expect(partial[0].store.stepsRun).toEqual(['regular']);
  });
});

describe('requirements re-check', () => {
  it('runs exactly one model call on the stored diff and replaces only the coverage', async () => {
    const { t, review } = await reviewedTwoFiles(() => requirementsReply());
    const before: StagedReview = {
      ...review,
      requirements: { kind: 'goal', text: 'old goal' },
      coverage: { ticketKey: 'Stated goal', reading: 'old reading', requirements: [], outOfScope: [], noClearRequirements: true, unseenFileCount: 0 },
    };
    t.client.rawDiff = 'diff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -0,0 +1 @@\n+changed later\n';

    const result = await recheckRequirements(before, { kind: 'goal', text: 'In scope:\n- only the backend endpoint' }, ONE_FILE_PER_BATCH, t.deps);

    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].kind).toBe('requirements');
    expect(t.calls[0].prompt).toContain('only the backend endpoint');
    expect(t.calls[0].prompt).toContain('### File: src/f1.ts');
    expect(t.calls[0].prompt).not.toContain('src/other.ts');
    expect(result.outcome).toEqual({ status: 'checked' });
    expect(result.review.coverage?.reading).toContain('retried automatically');
    expect(result.review.coverage?.userGoal).toBe('In scope:\n- only the backend endpoint');
    expect(result.review.store).toEqual(before.store);
    expect(result.review.snapshot).toEqual(before.snapshot);
  });

  it('keeps the old coverage when the re-check fails', async () => {
    const { t, review } = await reviewedTwoFiles(() => 'not json at all');
    const coverage = { ticketKey: 'Stated goal', reading: 'old reading', requirements: [], outOfScope: [], noClearRequirements: true, unseenFileCount: 0 };

    const result = await recheckRequirements({ ...review, coverage }, { kind: 'goal', text: 'new goal' }, ONE_FILE_PER_BATCH, t.deps);

    expect(result.outcome).toEqual({ status: 'failed' });
    expect(result.review.coverage).toEqual(coverage);
  });
});
