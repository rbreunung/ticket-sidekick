import { describe, it, expect, vi } from 'vitest';
import { createTokenMeter, type MeterableModel } from '../participant/bitbucket/tokenMeter';
import type { TokenFigures } from '../utils/tokenUsage';

type Msg = { content: Array<{ value: string }> };
const msg = (value: string): Msg => ({ content: [{ value }] });

interface FakeOptions {
  chunks?: string[];
  failAfter?: number; // throw after this many chunks
  countInput?: (text: string) => number | Error;
  countOutput?: (text: string) => number | Error;
  rejectSend?: Error;
}

function fakeModel(options: FakeOptions = {}) {
  const chunks = options.chunks ?? ['abc'];
  const model = {
    id: 'claude-sonnet-4.5',
    family: 'claude-sonnet',
    maxInputTokens: 100_000,
    async countTokens(input: string | Msg) {
      const text = typeof input === 'string' ? input : input.content.map((p) => p.value).join('');
      const isOutput = typeof input === 'string';
      const result = (isOutput ? options.countOutput : options.countInput)?.(text) ?? text.length;
      if (result instanceof Error) throw result;
      return result;
    },
    async sendRequest(_messages: Msg[]) {
      if (options.rejectSend) throw options.rejectSend;
      return {
        text: (async function* () {
          for (let i = 0; i < chunks.length; i++) {
            if (options.failAfter !== undefined && i === options.failAfter) throw new Error('stream broke');
            yield chunks[i];
          }
        })(),
      };
    },
  };
  return model as unknown as MeterableModel<Msg> & typeof model;
}

async function drain(response: { text: AsyncIterable<string> }): Promise<string> {
  let out = '';
  for await (const c of response.text) out += c;
  return out;
}

describe('createTokenMeter', () => {
  it('counts input and output of a call and records them once', async () => {
    const record = vi.fn<[string, TokenFigures], Promise<void>>().mockResolvedValue();
    const { model, totals } = createTokenMeter(fakeModel({ chunks: ['hello ', 'world'], countInput: () => 100, countOutput: () => 20 }), record);
    const text = await drain(await model.sendRequest([msg('question')]));
    expect(text).toBe('hello world');
    expect(totals()).toEqual({ input: 100, output: 20, calls: 1, estimated: false });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith('claude-sonnet-4.5', { input: 100, output: 20, estimated: false });
  });

  it('passes other model properties and methods through', async () => {
    const { model } = createTokenMeter(fakeModel(), vi.fn().mockResolvedValue(undefined));
    expect(model.family).toBe('claude-sonnet');
    expect(model.maxInputTokens).toBe(100_000);
    expect(await model.countTokens('abcd')).toBe(4);
  });

  it('falls back to chars/4 and marks the call estimated when input counting fails', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const { model, totals } = createTokenMeter(fakeModel({ countInput: () => new Error('no tokenizer'), countOutput: () => 5 }), record);
    await drain(await model.sendRequest([msg('12345678')]));
    expect(totals()).toEqual({ input: 2, output: 5, calls: 1, estimated: true });
    expect(record).toHaveBeenCalledWith('claude-sonnet-4.5', { input: 2, output: 5, estimated: true });
  });

  it('falls back to chars/4 and marks the call estimated when output counting fails', async () => {
    const { model, totals } = createTokenMeter(
      fakeModel({ chunks: ['12345678'], countInput: () => 9, countOutput: () => new Error('boom') }),
      vi.fn().mockResolvedValue(undefined),
    );
    await drain(await model.sendRequest([msg('q')]));
    expect(totals()).toEqual({ input: 9, output: 2, calls: 1, estimated: true });
  });

  it('counts the partial reply and rethrows when the stream breaks', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const { model, totals } = createTokenMeter(fakeModel({ chunks: ['ab', 'cd', 'ef'], failAfter: 2, countInput: () => 10, countOutput: (t) => t.length }), record);
    const response = await model.sendRequest([msg('q')]);
    await expect(drain(response)).rejects.toThrow('stream broke');
    expect(totals()).toEqual({ input: 10, output: 4, calls: 1, estimated: false });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('counts the reply read so far when the consumer stops early', async () => {
    const { model, totals } = createTokenMeter(fakeModel({ chunks: ['ab', 'cd'], countInput: () => 1, countOutput: (t) => t.length }), vi.fn().mockResolvedValue(undefined));
    const response = await model.sendRequest([msg('q')]);
    for await (const _chunk of response.text) break;
    expect(totals().output).toBe(2);
    expect(totals().calls).toBe(1);
  });

  it('counts nothing when the provider rejects the request', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const { model, totals } = createTokenMeter(fakeModel({ rejectSend: new Error('quota') }), record);
    await expect(model.sendRequest([msg('q')])).rejects.toThrow('quota');
    expect(totals()).toEqual({ input: 0, output: 0, calls: 0, estimated: false });
    expect(record).not.toHaveBeenCalled();
  });

  it('adds up several calls, as when a request is retried', async () => {
    const { model, totals } = createTokenMeter(fakeModel({ countInput: () => 10, countOutput: () => 3 }), vi.fn().mockResolvedValue(undefined));
    await drain(await model.sendRequest([msg('a')]));
    await drain(await model.sendRequest([msg('b')]));
    expect(totals()).toEqual({ input: 20, output: 6, calls: 2, estimated: false });
  });

  it('keeps separate totals for separate meters', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const a = createTokenMeter(fakeModel({ countInput: () => 10, countOutput: () => 1 }), record);
    const b = createTokenMeter(fakeModel({ countInput: () => 50, countOutput: () => 5 }), record);
    await drain(await a.model.sendRequest([msg('x')]));
    await drain(await b.model.sendRequest([msg('y')]));
    expect(a.totals().input).toBe(10);
    expect(b.totals().input).toBe(50);
  });

  it('does not fail the model call when recording fails, and reports it', async () => {
    const onDiag = vi.fn();
    const { model, totals } = createTokenMeter(fakeModel({ countInput: () => 1, countOutput: () => 1 }), vi.fn().mockRejectedValue(new Error('disk full')), onDiag);
    await expect(drain(await model.sendRequest([msg('q')]))).resolves.toBe('abc');
    expect(totals().calls).toBe(1);
    expect(onDiag).toHaveBeenCalledWith('warn', expect.stringContaining('token usage'), expect.anything());
  });

  it('exposes the model id for the footer', () => {
    expect(createTokenMeter(fakeModel(), vi.fn()).modelId).toBe('claude-sonnet-4.5');
  });
});

describe('createTokenMeter on read-only host objects', () => {
  it('meters a frozen model and counts a frozen reply', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const model = fakeModel({ chunks: ['hello'], countInput: () => 7, countOutput: () => 3 });
    const sendRequest = model.sendRequest.bind(model);
    // The host freezes its model and its replies: every property is read-only and non-configurable.
    Object.assign(model, { sendRequest: async (m: Msg[]) => Object.freeze(await sendRequest(m)) });
    Object.freeze(model);
    const meter = createTokenMeter(model, record);

    expect(await drain(await meter.model.sendRequest([msg('q')]))).toBe('hello');
    expect(meter.totals()).toEqual({ input: 7, output: 3, calls: 1, estimated: false });
    expect(record).toHaveBeenCalledWith('claude-sonnet-4.5', { input: 7, output: 3, estimated: false });
    expect(meter.metered).toBe(true);
  });

  it('reads every other property and method of a frozen model through unchanged', async () => {
    const { model } = createTokenMeter(Object.freeze(fakeModel()), vi.fn().mockResolvedValue(undefined));
    expect(model.id).toBe('claude-sonnet-4.5');
    expect(model.family).toBe('claude-sonnet');
    expect(model.maxInputTokens).toBe(100_000);
    expect(await model.countTokens('abcd')).toBe(4);
  });

  it('keeps the model as `this` for methods that use private state', async () => {
    class PrivateStateModel {
      readonly id = 'private-state';
      #windowSize = 128;
      async countTokens(): Promise<number> { return this.#windowSize; }
      async sendRequest() { return { text: (async function* () { yield 'ok'; })() }; }
    }
    const { model } = createTokenMeter(Object.freeze(new PrivateStateModel()) as unknown as MeterableModel, vi.fn().mockResolvedValue(undefined));
    expect(await model.countTokens('x')).toBe(128);
  });

  it('reads getter-based properties through', () => {
    const base = fakeModel();
    const withGetter = Object.freeze(Object.create(base, { family: { get: () => 'from-getter', enumerable: true } }));
    const { model } = createTokenMeter(withGetter as typeof base, vi.fn());
    expect(model.family).toBe('from-getter');
  });

  it('answers `in` for real properties only', () => {
    const { model } = createTokenMeter(Object.freeze(fakeModel()), vi.fn());
    expect('family' in model).toBe(true);
    expect('nonsense' in model).toBe(false);
  });

  it.each(['sendRequest', 'countTokens'] as const)('falls back to the raw model when reading `%s` throws', (property) => {
    const onDiag = vi.fn();
    const raw = fakeModel();
    Object.defineProperty(raw, property, { get() { throw new TypeError(`${property} is unreadable`); }, configurable: true });
    const meter = createTokenMeter(raw, vi.fn(), onDiag);

    expect(meter.model).toBe(raw);
    expect(meter.metered).toBe(false);
    expect(meter.totals()).toEqual({ input: 0, output: 0, calls: 0, estimated: false });
    expect(onDiag).toHaveBeenCalledWith('warn', expect.stringContaining('metering'), expect.objectContaining({ errorName: 'TypeError' }));
  });
});
