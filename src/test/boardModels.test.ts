import { describe, expect, it } from 'vitest';
import { MODEL_CHECK_PROMPT, checkModelAnswers, emailModelInUse, type BoardModels } from '../boards/boardModels';

// Which model the email check uses, and the one-call check a board makes after a pick.

describe('the model of the email check', () => {
  it('is the email setting, else the review setting, else none', () => {
    expect(emailModelInUse({ emailModel: () => ' gpt-x ', reviewModel: () => 'claude-y' })).toEqual({ id: 'gpt-x', source: 'email' });
    expect(emailModelInUse({ emailModel: () => '', reviewModel: () => 'claude-y' })).toEqual({ id: 'claude-y', source: 'review' });
    expect(emailModelInUse({ emailModel: () => '', reviewModel: () => '' })).toBeUndefined();
  });
});

describe('checking a model from a board', () => {
  it('sends the fixed message and logs the model and outcome only', async () => {
    const sent: string[] = [];
    const logs: Array<[string, string, unknown]> = [];
    const models: BoardModels = { list: async () => [], send: async (_id, prompt) => { sent.push(prompt); return 'ready'; } };
    expect(await checkModelAnswers(models, 'm1', (level, message, details) => logs.push([level, message, details]))).toEqual({ ok: true, modelId: 'm1' });
    expect(sent).toEqual([MODEL_CHECK_PROMPT]);
    expect(logs).toEqual([['info', 'A board called a language model', { modelId: 'm1', outcome: 'answered' }]]);
  });

  it('reports a refused call with its reason and code', async () => {
    const logs: unknown[] = [];
    const refused = Object.assign(new Error('Extension is not allowed'), { code: 'NoPermissions' });
    const models: BoardModels = { list: async () => [], send: async () => { throw refused; } };
    expect(await checkModelAnswers(models, 'm1', (_l, _m, details) => logs.push(details)))
      .toEqual({ ok: false, modelId: 'm1', error: 'Extension is not allowed' });
    expect(logs).toEqual([{ modelId: 'm1', outcome: 'failed', code: 'NoPermissions', error: 'Extension is not allowed' }]);
  });
});
