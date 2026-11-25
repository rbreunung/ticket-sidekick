import { describe, it, expect, vi } from 'vitest';
import { ModelRequestCancelledError, type BoardModelHandle } from '../boards/boardModels';
import {
  runCritic,
  runExtraPass,
  runRegularPass,
  type EngineDeps,
  type EngineSettings,
  type StagedReview,
} from '../review/engine';
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

type PromptKind = 'regular' | 'regular-whole-files' | 'security' | 'performance' | 'reliability' | 'maintainability' | 'critic';

function kindOf(prompt: string): PromptKind {
  if (prompt.startsWith('You are verifying the findings')) return 'critic';
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
  };
  return { client, calls: model.calls, controller, deps, recorded };
}

async function regular(t: ReturnType<typeof setup>, settings: EngineSettings = ONE_FILE_PER_BATCH) {
  return runRegularPass({ target: TARGET, settings }, t.deps);
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

describe('regular pass: no requirements check', () => {
  it('makes only the review calls and gives the review no coverage', async () => {
    const t = setup({ files: 2, respond: () => reviewReply([]) });

    const result = await regular(t);

    expect(t.calls.map((c) => c.kind)).toEqual(['regular', 'regular']);
    expect(t.calls.some((c) => c.prompt.includes('Jira ticket'))).toBe(false);
    expect(Object.keys(result.review!).sort()).toEqual(['snapshot', 'store', 'suggestion']);
    expect(result).not.toHaveProperty('requirements');
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

  it('fails, with the first failure, and is not marked as run when every batch failed, so it can be picked again', async () => {
    const { t, review } = await reviewedTwoFiles(() => { throw new Error('The model is overloaded'); });

    const result = await runExtraPass(review, 'security', ONE_FILE_PER_BATCH, t.deps);

    expect(result.outcome).toMatchObject({ status: 'failed', batchesTotal: 2, failedBatches: 2 });
    expect(result.outcome.error).toMatch(/overloaded/);
    expect(result.outcome.error).toBe(result.outcome.notes[0]);
    expect(result.review.store.stepsRun).toEqual(['regular']);
    expect(result.review.store.findings.map((f) => f.id)).toEqual([1, 2, 3]);
  });

  it('with one batch failed and one reviewed, finishes and is marked as run', async () => {
    const { t, review } = await reviewedTwoFiles((c) => {
      if (c.file === 2) throw new Error('The model is overloaded');
      return reviewReply([{ file: 1, line: 6, title: 'Timing leak' }]);
    });

    const result = await runExtraPass(review, 'security', ONE_FILE_PER_BATCH, t.deps);

    expect(result.outcome).toMatchObject({ status: 'finished', failedBatches: 1, added: [4] });
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

  it('a failed critic call leaves its findings in the review, unchecked, with a note saying so', async () => {
    const { t, review } = await reviewedTwoFiles(() => { throw Object.assign(new Error('The model is overloaded'), { code: 'Unknown' }); });

    const result = await runCritic(review, [], ONE_FILE_PER_BATCH, t.deps);

    expect(result.review.store.findings.map((f) => f.id)).toEqual([1, 2, 3]);
    expect(result.review.store.criticChecked).toEqual([]);
    expect(result.outcome).toMatchObject({ failedBatches: 2, removed: [] });
    expect(result.outcome.notes.length).toBeGreaterThan(0);
    for (const note of result.outcome.notes) expect(note).toMatch(/^critic batch \d\/2: \d finding\(s\) could not be checked and stay unchecked \(.*overloaded.*\)$/);
  });

  it('an unreadable verdict removes nothing and leaves the findings unchecked', async () => {
    const { t, review } = await reviewedTwoFiles(() => 'I had a look and most of these seem fine to me.');

    const result = await runCritic(review, [], ONE_FILE_PER_BATCH, t.deps);

    expect(result.review.store.findings.map((f) => f.id)).toEqual([1, 2, 3]);
    expect(result.review.store.criticChecked).toEqual([]);
    expect(result.outcome.removed).toEqual([]);
    expect(result.outcome.notes).toEqual([
      'critic batch 1/2: the verdict was unreadable, so 2 finding(s) stay unchecked',
      'critic batch 2/2: the verdict was unreadable, so 1 finding(s) stay unchecked',
    ]);
  });

  it('a critic asking for more files gets one more round with them, whose verdict counts', async () => {
    const { t, review } = await reviewedTwoFiles((c) => (c.prompt.includes('This is the final verification round')
      ? '{"keep":[1]}'
      : '{"keep":[],"additionalFilesNeeded":["src/auth.ts"]}'));
    t.client.fileContents.set('src/auth.ts', 'export const auth = 2;');
    const checked: StagedReview = { ...review, store: { ...review.store, criticChecked: [1, 2] } };

    const result = await runCritic(checked, [], ONE_FILE_PER_BATCH, t.deps);

    expect(t.calls).toHaveLength(2);
    expect(t.calls[1].prompt).toContain('This is the final verification round');
    expect(t.calls[1].prompt).toContain('src/auth.ts');
    expect(t.calls[1].prompt).toContain('export const auth = 2;');
    expect(result.review.store.findings.map((f) => f.id)).toEqual([1, 2, 3]);
    expect(result.outcome.removed).toEqual([]);
  });

  it('a garbled second round keeps the first verdict', async () => {
    const { t, review } = await reviewedTwoFiles((c) => (c.prompt.includes('This is the final verification round')
      ? 'Sorry, I cannot decide.'
      : '{"keep":[],"additionalFilesNeeded":["src/auth.ts"]}'));
    t.client.fileContents.set('src/auth.ts', 'export const auth = 2;');
    const checked: StagedReview = { ...review, store: { ...review.store, criticChecked: [1, 2] } };

    const result = await runCritic(checked, [], ONE_FILE_PER_BATCH, t.deps);

    expect(t.calls).toHaveLength(2);
    expect(result.outcome.removed).toEqual([3]);
    expect(result.review.store.findings.map((f) => f.id)).toEqual([1, 2]);
  });

  it('a Stop during the critic ends it stopped and leaves it unmarked as run', async () => {
    const { t, review } = await reviewedTwoFiles((c) => {
      if (c.prompt.includes('Swallowed error')) { t.controller.abort(); throw new ModelRequestCancelledError(); }
      return '{"keep":[1,2]}';
    });

    const result = await runCritic(review, [], ONE_FILE_PER_BATCH, t.deps);

    expect(result.outcome).toMatchObject({ status: 'stopped', batchesDone: 1, batchesTotal: 2 });
    expect(result.review.store.stepsRun).toEqual(['regular']);
    expect(result.review.store.criticChecked).toEqual([1, 2]);
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

/** The diff of test file `n` alone, as `prDiff` writes it. */
function fileDiff(n: number): string {
  return prDiff(n).split('diff --git ').filter(Boolean).map((part) => `diff --git ${part}`)[n - 1];
}

describe('regular pass: the rules every review pass keeps', () => {
  it('fetches the files a Data Center server cut from the diff one by one and reviews them, and names a file still cut and one it could not fetch', async () => {
    const t = setup({ files: 1, respond: (c) => reviewReply([{ file: c.file, line: 1, title: `Issue in f${c.file}` }]) });
    t.client.cutFiles = [{ path: 'src/f2.ts' }, { path: 'src/f3.ts' }, { path: 'src/f4.ts' }, { path: 'src/f5.ts' }];
    t.client.perFileDiffs.set('src/f2.ts', { raw: fileDiff(2), truncated: false });
    t.client.perFileDiffs.set('src/f3.ts', { raw: fileDiff(3), truncated: true });

    const result = await regular(t, { ...ONE_FILE_PER_BATCH, excludePatterns: ['**/f5.ts'] });

    expect(t.client.getPullRequestFileDiffCalls.map((c) => c.path)).toEqual(['src/f2.ts', 'src/f3.ts', 'src/f4.ts']);
    expect(t.calls.map((c) => c.file).sort()).toEqual([1, 2, 3]);
    expect(result.review!.store.findings.map((f) => f.file)).toEqual(['src/f1.ts', 'src/f2.ts', 'src/f3.ts']);
    const notes = result.outcome.notes.join('\n');
    expect(notes).toContain('reviewed partially: src/f3.ts');
    expect(notes).toContain('not reviewed: src/f4.ts');
  });

  it('asks for the configured context lines, and leaves out excluded files and files with no text change, saying how many', async () => {
    const t = setup({ files: 3, respond: (c) => reviewReply([{ file: c.file, line: 1, title: `Issue in f${c.file}` }]) });
    t.client.rawDiff = `${prDiff(3)}diff --git a/logo.png b/logo.png\n--- a/logo.png\n+++ b/logo.png\nBinary files differ\n`;

    const result = await regular(t, { ...ONE_FILE_PER_BATCH, contextLines: 25, excludePatterns: ['**/f3.ts'] });

    expect(t.client.getPullRequestDiffCalls.map((c) => c.contextLines)).toEqual([25]);
    expect(t.calls.map((c) => c.file).sort()).toEqual([1, 2]);
    expect(result.outcome.notes).toContain('1 file excluded by pattern.');
    expect(result.outcome.notes).toContain('1 file with no text changes (binary, rename or mode only) skipped.');
  });

  it('puts a finding on the line its quoted code is on, keeps one whose code is not in the diff as location unverified, and drops one naming a file outside the pull request', async () => {
    const finding = (file: string, line: number, anchorCode: string, title: string) => JSON.stringify({
      file, line, anchorCode, severity: 'warning', confidence: 0.8, title, description: `${title} described`, recommendation: `Fix ${title}`,
    });
    const t = setup({
      files: 1,
      respond: () => [
        finding('src/f1.ts', 9, codeLine(1, 3), 'Wrong line given'),
        finding('src/f1.ts', 5, 'const notInTheDiff = true;', 'Code not found'),
        finding('src/elsewhere.ts', 2, codeLine(1, 4), 'Outside the pull request'),
        JSON.stringify({ additionalFilesNeeded: [] }),
      ].join('\n'),
    });

    const result = await regular(t);

    const findings = result.review!.store.findings;
    expect(findings.map((f) => f.title)).toEqual(['Wrong line given', 'Code not found']);
    expect(findings[0].line).toBe(3);
    expect(findings[0].locationUnverified).toBeFalsy();
    expect(findings[1].locationUnverified).toBe(true);
    expect(findings[1].line).toBeUndefined();
  });

  it('gives a reply cut off mid-finding one continuation call that lists what it already reported, and keeps the findings of both', async () => {
    const t = setup({
      files: 1,
      respond: (c) => c.prompt.includes('Already reported for these files')
        ? reviewReply([{ file: 1, line: 6, title: 'Second issue' }])
        : `${findingLine({ file: 1, line: 2, title: 'First issue' })}\n{"file":"src/f1.ts","line":6,"anchorCo`,
    });

    const result = await regular(t);

    expect(t.calls).toHaveLength(2);
    expect(t.calls[1].prompt).toContain('First issue');
    expect(result.review!.store.findings.map((f) => f.title)).toEqual(['First issue', 'Second issue']);
    expect(result.outcome.failedBatches).toBe(0);
  });

  it('lets the call with the whole files a batch asked for retract a first finding by its number, and keeps the others', async () => {
    const t = setup({
      files: 1,
      respond: (c) => c.kind === 'regular-whole-files'
        ? [findingLine({ file: 1, line: 8, title: 'Seen in the whole file' }), JSON.stringify({ additionalFilesNeeded: [], retract: [1] })].join('\n')
        : reviewReply([{ file: 1, line: 2, title: 'Retracted later' }, { file: 1, line: 4, title: 'Kept' }], { additionalFilesNeeded: ['src/ctx.ts'] }),
    });
    t.client.fileContents.set('src/ctx.ts', 'export const ctx = 1;');

    const result = await regular(t);

    expect(t.calls.map((c) => c.kind)).toEqual(['regular', 'regular-whole-files']);
    expect(t.client.getFileContentCalls.map((c) => [c.path, c.commitHash])).toEqual([['src/ctx.ts', result.review!.snapshot.reviewedCommit]]);
    expect(result.review!.store.findings.map((f) => f.title).sort()).toEqual(['Kept', 'Seen in the whole file']);
  });

  it('retries a reply with no usable JSON like a provider error, and keeps the findings of the retry', async () => {
    const t = setup({
      files: 1,
      respond: (_c, index) => (index === 0 ? 'Sorry, I could not review this file.' : reviewReply([{ file: 1, line: 2, title: 'Found on retry' }])),
    });

    const result = await regular(t);

    expect(t.calls).toHaveLength(2);
    expect(result.outcome.failedBatches).toBe(0);
    expect(result.review!.store.findings.map((f) => f.title)).toEqual(['Found on retry']);
  });

  it('gives the review instructions and the upfront question to every review call, the persona passes and the critic', async () => {
    const t = setup({
      files: 1,
      respond: (c) => {
        if (c.kind === 'critic') return '{"keep":[1]}';
        if (c.kind === 'regular') return reviewReply([{ file: 1, line: 2, title: 'Unchecked input' }], { additionalFilesNeeded: ['src/ctx.ts'] });
        return reviewReply([]);
      },
    });
    t.client.fileContents.set('src/ctx.ts', 'export const ctx = 1;');
    const settings: EngineSettings = { ...ONE_FILE_PER_BATCH, reviewInstructions: 'Follow the house style guide.', focus: 'Is the retry loop bounded?' };

    const first = await runRegularPass({ target: TARGET, settings }, t.deps);
    const withSecurity = await runExtraPass(first.review!, 'security', settings, t.deps);
    await runCritic(withSecurity.review, [], settings, t.deps);

    expect(t.calls.map((c) => c.kind)).toEqual(['regular', 'regular-whole-files', 'security', 'critic']);
    for (const call of t.calls) {
      expect(call.prompt, call.kind).toContain('Follow the house style guide.');
      expect(call.prompt, call.kind).toContain('Is the retry loop bounded?');
    }
  });

});

describe('diagnostic timeline in the output channel', () => {
  type Line = { level: string; message: string; details?: Record<string, unknown> };
  function capture(t: ReturnType<typeof setup>): Line[] {
    const lines: Line[] = [];
    t.deps.onDiag = (level, message, details) => { lines.push({ level, message, ...(details ? { details } : {}) }); };
    t.deps.model = { ...t.deps.model, vendor: 'copilot', family: 'gpt-test', version: '1' };
    return lines;
  }
  const callLines = (lines: Line[]) => lines.filter((l) => / attempt \d+ — /.test(l.message));

  it('opens with the configuration and the model in use, then logs one call line per model call naming its pass and batch', async () => {
    const t = setup({
      files: 2,
      respond: (c) => {
        if (c.kind === 'critic') return '{"keep":[1]}';
        if (c.kind === 'regular' && c.file === 1) return reviewReply([{ file: 1, line: 3, title: 'Missing null check' }], { additionalFilesNeeded: ['src/ctx.ts'] });
        if (c.kind === 'regular-whole-files') return reviewReply([], { additionalFilesNeeded: [] });
        return reviewReply([]);
      },
    });
    t.client.fileContents.set('src/ctx.ts', 'export const ctx = 1;');
    const lines = capture(t);
    const settings: EngineSettings = { ...ONE_FILE_PER_BATCH, contextLines: 5 };

    const first = await runRegularPass({ target: TARGET, settings }, t.deps);
    const withSecurity = await runExtraPass(first.review!, 'security', settings, t.deps);
    await runCritic(withSecurity.review, [], settings, t.deps);

    expect(lines[0].message).toBe('pr=PROJ/app#42 model=copilot/gpt-test tokenBudget=2000 (resolved=2000 ratio=1) passes=regular critic=false contextLines=5');
    expect(lines.find((l) => l.message === 'pr=PROJ/app#42 model=copilot/gpt-test tokenBudget=2000 (resolved=2000 ratio=1) passes=critic critic=true contextLines=5')).toBeDefined();
    const model = lines.find((l) => l.message === 'model in use')!;
    expect(model.details).toMatchObject({ vendor: 'copilot', family: 'gpt-test', id: 'test-model', maxInputTokens: 100_000, metering: 'on', frozen: false });
    const calls = callLines(lines).map((l) => l.message.replace(/ — .*/, ''));
    expect(calls).toEqual([
      '[pr=PROJ/app#42] pass1 batch 1/2 attempt 1',
      '[pr=PROJ/app#42] pass2 batch 1/2 attempt 1',
      '[pr=PROJ/app#42] pass1 batch 2/2 attempt 1',
      '[pr=PROJ/app#42] security batch 1/2 attempt 1',
      '[pr=PROJ/app#42] security batch 2/2 attempt 1',
      '[pr=PROJ/app#42] critic batch 1/2 attempt 1',
    ]);
    expect(calls).toHaveLength(t.calls.length);
    expect(callLines(lines)[0].message).toMatch(/1 item\(s\), prompt \d+c \(~\d+ tok\), response \d+c, \d+ms, ok$/);
  });

  it('after a transient failure logs the failed call and the identical retry, and after one that is not transient says it does not retry', async () => {
    const t = setup({
      files: 1,
      respond: (_c, index) => {
        if (index === 0) throw Object.assign(new Error('provider hiccup'), { code: 'Unknown' });
        return reviewReply([]);
      },
    });
    const lines = capture(t);
    await regular(t);
    expect(lines.map((l) => l.message)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^\[pr=PROJ\/app#42\] pass1 attempt 1 — .*, error \(Unknown\)$/),
      '[pr=PROJ/app#42] pass1 batch 1/1 — identical retry in flight (attempt 2)',
      expect.stringMatching(/^\[pr=PROJ\/app#42\] pass1 attempt 2 — .*, ok$/),
    ]));

    const refused = setup({ files: 1, respond: () => { throw Object.assign(new Error('not allowed'), { code: 'NoPermissions' }); } });
    const refusedLines = capture(refused);
    await regular(refused);
    expect(refusedLines.map((l) => l.message)).toContain('[pr=PROJ/app#42] pass1 batch 1/1 — not retrying: Error is not a transient provider error');
    expect(refusedLines.map((l) => l.message)).not.toContain('[pr=PROJ/app#42] pass1 batch 1/1 — identical retry in flight (attempt 2)');
  });

  it('says when it splits a batch of two files after two transient failures', async () => {
    const t = setup({
      files: 2,
      respond: (_c, index) => {
        if (index < 2) throw Object.assign(new Error('provider hiccup'), { code: 'Unknown' });
        return reviewReply([]);
      },
    });
    const lines = capture(t);
    await regular(t, TWO_FILES_PER_BATCH);
    expect(lines.map((l) => l.message)).toContain('[pr=PROJ/app#42] pass1 batch 1/1 — splitting into halves of 1 and 1 after repeated failure');
  });

  it('logs a cut-off reply as a truncation event and the continuation it starts', async () => {
    const t = setup({
      files: 1,
      respond: (c) => c.prompt.includes('Already reported for these files')
        ? reviewReply([])
        : `${findingLine({ file: 1, line: 2, title: 'First issue' })}\n{"file":"src/f1.ts","line":6,"anchorCo`,
    });
    const lines = capture(t);
    await regular(t);
    const truncation = lines.find((l) => l.message === 'Truncated response — [pr=PROJ/app#42] batch 1/1')!;
    expect(truncation.level).toBe('warn');
    expect(truncation.details).toMatchObject({ completeLines: 1, hasMetaLine: false, coveredFiles: ['src/f1.ts'] });
    expect(lines.map((l) => l.message)).toContain('[pr=PROJ/app#42] batch 1/1 — continuation starting with 1 file(s)');
    expect(callLines(lines).map((l) => l.message.replace(/ attempt.*/, ''))).toEqual(['[pr=PROJ/app#42] pass1', '[pr=PROJ/app#42] continuation']);
  });

  it('logs the findings funnel: 5 raw, 1 outside the pull request, 1 retracted by the whole-file call, 1 duplicate, 2 final', async () => {
    const outside = JSON.stringify({
      file: 'src/elsewhere.ts', line: 2, anchorCode: codeLine(1, 4), severity: 'warning', confidence: 0.8, title: 'Outside', description: 'd', recommendation: 'r',
    });
    const t = setup({
      files: 1,
      respond: (c) => c.kind === 'regular-whole-files'
        ? [findingLine({ file: 1, line: 8, title: 'Seen in the whole file' }), findingLine({ file: 1, line: 4, title: 'Kept' }), JSON.stringify({ additionalFilesNeeded: [], retract: [1] })].join('\n')
        : [findingLine({ file: 1, line: 2, title: 'Retracted later' }), findingLine({ file: 1, line: 4, title: 'Kept' }), outside, JSON.stringify({ additionalFilesNeeded: ['src/ctx.ts'] })].join('\n'),
    });
    t.client.fileContents.set('src/ctx.ts', 'export const ctx = 1;');
    const lines = capture(t);

    const result = await regular(t);

    expect(result.review!.store.findings).toHaveLength(2);
    expect(result.outcome.droppedOutsidePr).toBe(1);
    expect(lines.map((l) => l.message)).toContain([
      'Findings funnel — raw 5',
      '-> deduped as duplicate: 1',
      '-> dropped as outside the PR: 1',
      '-> retracted by Pass 2: 1',
      '-> final: 2',
    ].join('\n'));
  });

  it('writes the structured run record to the output channel only when detailed diagnostics is on', async () => {
    const respond = (c: Call) => reviewReply([{ file: c.file, line: 2, title: 'Unchecked input' }]);
    const on = setup({ files: 1, respond });
    const onLines = capture(on);
    await regular(on, { ...ONE_FILE_PER_BATCH, detailedDiagnostics: true });
    const messages = onLines.map((l) => l.message);
    const start = messages.indexOf('```');
    expect(start).toBeGreaterThan(-1);
    const record = messages.slice(start, messages.lastIndexOf('```') + 1);
    expect(record).toContain('Run: pr=PROJ/app#42');
    expect(record).toContain('Configuration:');
    expect(record).toContain(messages[0]);
    expect(record.some((line) => /pass1 attempt 1 — .*, ok$/.test(line))).toBe(true);
    expect(record).toContain('Findings funnel:');
    expect(record).toContain('-> final: 1');

    const off = setup({ files: 1, respond });
    const offLines = capture(off);
    await regular(off);
    expect(offLines.map((l) => l.message)).not.toContain('Configuration:');
    expect(offLines.map((l) => l.message)).not.toContain('```');
  });

  it('says no file could be reviewed when every batch failed, and names the last stage when the review aborts', async () => {
    const failed = setup({ files: 2, respond: () => { throw Object.assign(new Error('not allowed'), { code: 'NoPermissions' }); } });
    const failedLines = capture(failed);
    await regular(failed);
    const noFile = failedLines.find((l) => l.message === 'Review failed — no file could be reviewed — pr=PROJ/app#42')!;
    expect(noFile.level).toBe('error');
    expect(noFile.details).toMatchObject({ fileCount: 2, batchCount: 2, reviewedFileCount: 0, failedFileCount: 2 });

    const aborted = setup({ files: 1, respond: () => reviewReply([]) });
    vi.spyOn(aborted.client, 'getPullRequest').mockRejectedValue(new Error('503 Service Unavailable'));
    const abortedLines = capture(aborted);
    const result = await regular(aborted);
    expect(result.outcome.status).toBe('failed');
    expect(abortedLines.find((l) => l.message === 'Review aborted — [pr=PROJ/app#42] last stage: fetching PR')?.level).toBe('error');
  });
});

describe('what a pass did not review', () => {
  it('names files that failed after retrying only for a transient error', async () => {
    const t = setup({
      files: 2,
      respond: (c) => {
        if (c.file === 1) throw Object.assign(new Error('provider hiccup'), { code: 'Unknown' });
        throw Object.assign(new Error('not allowed'), { code: 'NoPermissions' });
      },
    });
    const result = await regular(t);
    expect(result.outcome.notes).toEqual([
      'regular batch 1/2 — could not review src/f1.ts after retrying: provider hiccup',
      'regular batch 2/2 — could not review src/f2.ts: not allowed',
    ]);
  });
});
