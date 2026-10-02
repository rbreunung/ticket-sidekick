/**
 * Counts the tokens of every call a chat model makes during one `@bitbucket` response.
 *
 * `createTokenMeter` wraps the model in a proxy that replaces only `sendRequest`: input is counted
 * once the provider accepts the request, output when the reply stream ends, breaks, or is abandoned.
 * Every other property and method reads through to the original model. Typed structurally (no
 * `vscode` import) so Vitest can load it; the participant passes in the real `LanguageModelChat`.
 *
 * The host may hand over frozen objects whose properties are read-only and non-configurable. A proxy
 * whose `get` trap returns anything but the real value for such a property throws, so both wrappers
 * proxy an empty target and read from the real object themselves. If the model still cannot be wrapped,
 * the meter fails open: the raw model is returned and the response simply goes uncounted.
 */
import type { TokenFigures } from '../../utils/tokenUsage';
import type { DiagLogger } from '../../utils/diagTypes';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface MeterableModel<Msg = any> {
  readonly id: string;
  countTokens(text: string | Msg, ...rest: any[]): PromiseLike<number>;
  sendRequest(messages: Msg[], ...rest: any[]): PromiseLike<{ text: AsyncIterable<string> }>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface MeterTotals {
  input: number;
  output: number;
  calls: number;
  /** True when any counted figure fell back to the `chars / 4` estimate. */
  estimated: boolean;
}

export interface TokenMeter<M> {
  /** The wrapped model; use it for every model call in the response. */
  model: M;
  modelId: string;
  /** False when the model could not be wrapped and calls go uncounted. */
  metered: boolean;
  totals(): MeterTotals;
}

type Counted = { tokens: number; estimated: boolean };

const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

/** Plain text of a chat message, for the estimate fallback. */
function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof (part as { value?: unknown })?.value === 'string' ? (part as { value: string }).value : ''))
    .join('');
}

export function createTokenMeter<M extends MeterableModel>(
  model: M,
  record: (modelId: string, figures: TokenFigures) => PromiseLike<void>,
  onDiag?: DiagLogger,
): TokenMeter<M> {
  const totals: MeterTotals = { input: 0, output: 0, calls: 0, estimated: false };

  async function countInput(messages: unknown[]): Promise<Counted> {
    try {
      let tokens = 0;
      for (const message of messages) tokens += await model.countTokens(message);
      return { tokens, estimated: false };
    } catch {
      return { tokens: estimateTokens(messages.reduce<number>((sum, m) => sum + messageText(m).length, 0)), estimated: true };
    }
  }

  async function countOutput(text: string): Promise<Counted> {
    if (text.length === 0) return { tokens: 0, estimated: false };
    try {
      return { tokens: await model.countTokens(text), estimated: false };
    } catch {
      return { tokens: estimateTokens(text.length), estimated: true };
    }
  }

  async function sendRequest(messages: unknown[], ...rest: unknown[]) {
    // A request the provider rejects throws here and counts nothing.
    const response = await model.sendRequest(messages, ...rest);
    const inputCount = countInput(messages);

    async function finish(replyText: string): Promise<void> {
      const input = await inputCount;
      const output = await countOutput(replyText);
      const figures: TokenFigures = {
        input: input.tokens,
        output: output.tokens,
        estimated: input.estimated || output.estimated,
      };
      totals.input += figures.input;
      totals.output += figures.output;
      totals.calls += 1;
      totals.estimated = totals.estimated || figures.estimated;
      try {
        await record(model.id, figures);
      } catch (err) {
        onDiag?.('warn', 'Could not record token usage', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    let counted: AsyncIterable<string> | undefined;
    const text = (): AsyncIterable<string> => {
      counted ??= (async function* () {
        let collected = '';
        try {
          for await (const chunk of response.text) {
            collected += chunk;
            yield chunk;
          }
        } finally {
          await finish(collected);
        }
      })();
      return counted;
    };

    // Empty target: the proxy invariants only look at the target's own properties, so a frozen reply
    // can never make this wrapper throw.
    return new Proxy({} as typeof response, {
      get(_target, prop) {
        if (prop === 'text') return text();
        return Reflect.get(response, prop, response);
      },
      has: (_target, prop) => prop in response,
    });
  }

  const wrapped = new Proxy({} as M, {
    get(_target, prop) {
      if (prop === 'sendRequest') return sendRequest;
      const value = Reflect.get(model, prop, model);
      return typeof value === 'function' ? value.bind(model) : value;
    },
    has: (_target, prop) => prop in model,
  });

  try {
    // `wrapped.sendRequest` never touches the real model, so probe the real one.
    if (typeof Reflect.get(model, 'sendRequest', model) !== 'function') throw new TypeError('the model has no callable sendRequest');
    void wrapped.countTokens;
    void wrapped.id;
  } catch (err) {
    onDiag?.('warn', 'Token metering disabled — the model could not be wrapped; this response goes uncounted', {
      errorName: err instanceof Error ? err.name : typeof err,
      error: err instanceof Error ? err.message : String(err),
    });
    return { model, modelId: safeModelId(model), metered: false, totals: () => ({ input: 0, output: 0, calls: 0, estimated: false }) };
  }

  return { model: wrapped, modelId: model.id, metered: true, totals: () => ({ ...totals }) };
}

function safeModelId(model: { id?: unknown }): string {
  try {
    return typeof model.id === 'string' ? model.id : 'unknown';
  } catch {
    return 'unknown';
  }
}
