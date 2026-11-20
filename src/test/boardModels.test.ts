import { describe, expect, it } from 'vitest';
import {
  MODEL_CHECK_PROMPT, ModelRequestCancelledError, checkModelAnswers, emailModelInUse, modelHandle, reviewModelInUse, reviewModelState,
  type BoardChatMessage, type BoardModels, type CancellableChatModel,
} from '../boards/boardModels';
import { PartialLmResponseError, isTransientLmError } from '../utils/lmRetry';

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
    const models: BoardModels = { list: async () => [], send: async (_id, prompt) => { sent.push(prompt); return 'ready'; }, handle: async () => undefined };
    expect(await checkModelAnswers(models, 'm1', (level, message, details) => logs.push([level, message, details]))).toEqual({ ok: true, modelId: 'm1' });
    expect(sent).toEqual([MODEL_CHECK_PROMPT]);
    expect(logs).toEqual([['info', 'A board called a language model', { modelId: 'm1', outcome: 'answered' }]]);
  });

  it('reports a refused call with its reason and code', async () => {
    const logs: unknown[] = [];
    const refused = Object.assign(new Error('Extension is not allowed'), { code: 'NoPermissions' });
    const models: BoardModels = { list: async () => [], send: async () => { throw refused; }, handle: async () => undefined };
    expect(await checkModelAnswers(models, 'm1', (_l, _m, details) => logs.push(details)))
      .toEqual({ ok: false, modelId: 'm1', error: 'Extension is not allowed' });
    expect(logs).toEqual([{ modelId: 'm1', outcome: 'failed', code: 'NoPermissions', error: 'Extension is not allowed' }]);
  });
});

// The review's model: a handle that streams one request under an abort signal, and the setting it is named by.

/** A cancellation source like VS Code's: cancel() fires the listeners once. */
function fakeCancellation() {
  const listeners: Array<() => void> = [];
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (fn: () => void) => { listeners.push(fn); },
  };
  return {
    token,
    cancel: () => { if (token.isCancellationRequested) return; token.isCancellationRequested = true; listeners.forEach(fn => fn()); },
    dispose: () => {},
  };
}
type FakeToken = ReturnType<typeof fakeCancellation>['token'];

/** A chat model that streams its fragments, one per tick, and stops with an error when its token is cancelled, as VS Code's does. */
function fakeChatModel(fragments: string[], counts: { input: number; output: number } = { input: 0, output: 0 }) {
  const calls: Array<{ messages: BoardChatMessage[] }> = [];
  const model: CancellableChatModel<FakeToken> = {
    id: 'm1',
    maxInputTokens: 128000,
    countTokens: async text => (typeof text === 'string' ? counts.output : counts.input),
    sendRequest: async (messages, token) => {
      calls.push({ messages });
      return {
        text: (async function* () {
          for (const fragment of fragments) {
            await new Promise(resolve => setTimeout(resolve, 0));
            if (token.isCancellationRequested) throw new Error('Canceled');
            yield fragment;
          }
        })(),
      };
    },
  };
  return { model, calls };
}

async function readAll(text: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const fragment of text) out.push(fragment);
  return out;
}

const USER = (content: string): BoardChatMessage => ({ role: 'user', content });

describe('a model request from a board', () => {
  it('streams the reply fragments in order and reports the model\'s token counts', async () => {
    const { model } = fakeChatModel(['The ', 'diff ', 'is fine.'], { input: 42, output: 7 });
    const handle = modelHandle(model, fakeCancellation);
    expect(handle.id).toBe('m1');
    expect(handle.maxInputTokens).toBe(128000);
    expect(await handle.countTokens(USER('Review this'))).toBe(42);
    expect(await handle.countTokens('The diff is fine.')).toBe(7);
    const response = await handle.sendRequest([USER('Review this')], { signal: new AbortController().signal });
    expect(await readAll(response.text)).toEqual(['The ', 'diff ', 'is fine.']);
  });

  it('ends with the cancellation error when the developer stops it mid-reply, and the retry helpers do not retry it', async () => {
    const { model } = fakeChatModel(['one ', 'two ', 'three']);
    const handle = modelHandle(model, fakeCancellation);
    const stop = new AbortController();
    const response = await handle.sendRequest([USER('Review this')], { signal: stop.signal });
    const seen: string[] = [];
    let failure: unknown;
    try {
      for await (const fragment of response.text) {
        seen.push(fragment);
        if (seen.length === 1) stop.abort();
      }
    } catch (err) {
      failure = err;
    }
    expect(seen).toEqual(['one ']);
    expect(failure).toBeInstanceOf(ModelRequestCancelledError);
    expect(failure).not.toBeInstanceOf(PartialLmResponseError);
    expect(isTransientLmError(failure)).toBe(false);
  });

  it('ends with the cancellation error even when the model keeps streaming after the stop', async () => {
    // A model that ignores its cancellation token.
    const stubborn: CancellableChatModel<FakeToken> = {
      id: 'm1', maxInputTokens: 1000, countTokens: async () => 0,
      sendRequest: async () => ({ text: (async function* () { yield 'a'; await new Promise(() => {}); })() }),
    };
    const stop = new AbortController();
    const response = await modelHandle(stubborn, fakeCancellation).sendRequest([USER('x')], { signal: stop.signal });
    const reading = (async () => { for await (const _ of response.text) stop.abort(); })();
    await expect(reading).rejects.toBeInstanceOf(ModelRequestCancelledError);
  });

  it('refuses a request under a signal that has already stopped, without calling the model', async () => {
    const { model, calls } = fakeChatModel(['never']);
    const stop = new AbortController();
    stop.abort();
    await expect(modelHandle(model, fakeCancellation).sendRequest([USER('x')], { signal: stop.signal }))
      .rejects.toBeInstanceOf(ModelRequestCancelledError);
    expect(calls).toEqual([]);
  });
});

describe('the review model', () => {
  const info = (id: string) => ({ id, name: id, vendor: 'copilot', family: id });

  it.each([
    ['', undefined],
    ['  ', undefined],
    [' m1 ', 'm1'],
  ])('with the setting %j is %j', (setting, expected) => {
    expect(reviewModelInUse({ reviewModel: () => setting })).toBe(expected);
  });

  it('asks for a pick when the setting is empty or names a model that is not available', async () => {
    const models = { list: async () => [info('m1'), info('m2')] };
    expect(await reviewModelState(models, { reviewModel: () => '  ' })).toEqual({ state: 'none' });
    expect(await reviewModelState(models, { reviewModel: () => 'gone' })).toEqual({ state: 'unavailable', id: 'gone' });
    expect(await reviewModelState(models, { reviewModel: () => 'm2' })).toEqual({ state: 'ready', model: info('m2') });
  });
});
