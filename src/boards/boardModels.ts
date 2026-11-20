import type { DiagLogger } from '../utils/diagTypes';

// The language models a board may call, without a chat request: the extension asks VS Code for the
// models the developer has, and calls the one a setting names. Which model is in use, the one-call
// check after a pick, the cancellable model handle and the setting names live here; the VS Code calls
// are bound in registerBoards.ts. vscode-free.

/** The model the email boilerplate check uses; when empty, the review model's setting is used. */
export const EMAIL_MODEL_SETTING = 'ticketSidekick.email.checkModel';
/** The model the pull request review passes use. */
export const REVIEW_MODEL_SETTING = 'ticketSidekick.bitbucket.reviewModel';

export interface BoardModelInfo {
  id: string;
  name: string;
  vendor: string;
  family: string;
}

export interface BoardModels {
  /** The models available to the developer; empty when none is. */
  list(): Promise<BoardModelInfo[]>;
  /** Sends one user message to the model with this id and returns the reply's text; throws when the model is not there or refuses. */
  send(id: string, prompt: string): Promise<string>;
  /** The model with this id as a handle for streamed, stoppable requests; undefined when it is not available. */
  handle(id: string): Promise<BoardModelHandle | undefined>;
}

/** One chat message, as a board builds it; the binding turns it into VS Code's message. */
export interface BoardChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface BoardModelRequestOptions {
  /** Aborting it stops the request: the reply ends with a `ModelRequestCancelledError`. */
  signal: AbortSignal;
}

/**
 * A model a board streams requests to. Its shape is the structural model the token meter wraps
 * (`createTokenMeter`), so every call through a metered handle counts toward the token counters.
 */
export interface BoardModelHandle {
  readonly id: string;
  readonly maxInputTokens: number;
  /** Who the model is, for the review's diagnostic lines. */
  readonly vendor?: string;
  readonly family?: string;
  readonly version?: string;
  /** Whether the host handed the model over as a frozen object (logged; the token meter copes with it). */
  readonly frozen?: boolean;
  countTokens(text: string | BoardChatMessage): Promise<number>;
  sendRequest(messages: BoardChatMessage[], options: BoardModelRequestOptions): Promise<{ text: AsyncIterable<string> }>;
}

/**
 * A request the developer stopped. It is not a provider failure: the retry helpers rethrow it at once
 * (`isTransientLmError` is false for it, as its code is not `Unknown`), and the text sent before the
 * stop is not kept as a partial reply.
 */
export class ModelRequestCancelledError extends Error {
  readonly code = 'Cancelled';
  constructor(options?: { cause?: unknown }) {
    super('The model request was stopped.', options);
    this.name = 'ModelRequestCancelledError';
  }
}

/** A VS Code cancellation source in the shape the handle needs; the binding passes the real one. */
export interface CancellationSourceLike<Token> {
  readonly token: Token;
  cancel(): void;
  dispose(): void;
}

/** The selected model as the binding hands it over: requests take a cancellation token instead of a signal. */
export interface CancellableChatModel<Token> {
  readonly id: string;
  readonly maxInputTokens: number;
  readonly vendor?: string;
  readonly family?: string;
  readonly version?: string;
  readonly frozen?: boolean;
  countTokens(text: string | BoardChatMessage): PromiseLike<number>;
  sendRequest(messages: BoardChatMessage[], token: Token): PromiseLike<{ text: AsyncIterable<string> }>;
}

/**
 * The handle over a selected model: each request gets its own cancellation source, cancelled when the
 * signal aborts. A request under a signal that has already aborted is refused without calling the
 * model, and a reply that is stopped ends with a `ModelRequestCancelledError` at once, even when the
 * model keeps streaming.
 */
export function modelHandle<Token>(model: CancellableChatModel<Token>, newCancellation: () => CancellationSourceLike<Token>): BoardModelHandle {
  return {
    id: model.id,
    maxInputTokens: model.maxInputTokens,
    ...(model.vendor !== undefined ? { vendor: model.vendor } : {}),
    ...(model.family !== undefined ? { family: model.family } : {}),
    ...(model.version !== undefined ? { version: model.version } : {}),
    ...(model.frozen !== undefined ? { frozen: model.frozen } : {}),
    countTokens: async text => model.countTokens(text),
    sendRequest: async (messages, { signal }) => {
      if (signal.aborted) throw new ModelRequestCancelledError();
      const source = newCancellation();
      let stopped!: () => void;
      const whenStopped = new Promise<never>((_resolve, reject) => { stopped = () => reject(new ModelRequestCancelledError()); });
      whenStopped.catch(() => {});
      const onAbort = () => { source.cancel(); stopped(); };
      signal.addEventListener('abort', onAbort, { once: true });
      const release = () => { signal.removeEventListener('abort', onAbort); source.dispose(); };
      let response: { text: AsyncIterable<string> };
      try {
        response = await Promise.race([model.sendRequest(messages, source.token), whenStopped]);
      } catch (err) {
        release();
        throw signal.aborted && !(err instanceof ModelRequestCancelledError) ? new ModelRequestCancelledError({ cause: err }) : err;
      }
      const text = async function* (): AsyncGenerator<string> {
        const fragments = response.text[Symbol.asyncIterator]();
        try {
          for (;;) {
            const next = await Promise.race([fragments.next(), whenStopped]);
            if (next.done) break;
            yield next.value;
          }
          // A model that ends its stream quietly on cancellation still sent only part of a reply.
          if (signal.aborted) throw new ModelRequestCancelledError();
        } catch (err) {
          if (signal.aborted && !(err instanceof ModelRequestCancelledError)) throw new ModelRequestCancelledError({ cause: err });
          throw err;
        } finally {
          release();
          // Not awaited: a model that ignores its token may never settle its pending fragment.
          void Promise.resolve(fragments.return?.()).catch(() => {});
        }
      };
      return { text: text() };
    },
  };
}

/** The two model settings as they are now, and the write of a pick. */
export interface ModelSettings {
  emailModel(): string;
  reviewModel(): string;
  writeEmailModel(id: string): Promise<void>;
  writeReviewModel(id: string): Promise<void>;
}

export type ModelSource = 'email' | 'review';

/** The model the email check uses: the email setting, else the review setting, else none. */
export function emailModelInUse(settings: Pick<ModelSettings, 'emailModel' | 'reviewModel'>): { id: string; source: ModelSource } | undefined {
  const email = settings.emailModel().trim();
  if (email) return { id: email, source: 'email' };
  const review = settings.reviewModel().trim();
  return review ? { id: review, source: 'review' } : undefined;
}

/** The model the review uses: its setting, else none. */
export function reviewModelInUse(settings: Pick<ModelSettings, 'reviewModel'>): string | undefined {
  return settings.reviewModel().trim() || undefined;
}

/** Whether the review can call its model: none set and a setting naming a model that is not listed both ask the developer to pick. */
export type ReviewModelState =
  | { state: 'none' }
  | { state: 'unavailable'; id: string }
  | { state: 'ready'; model: BoardModelInfo };

export async function reviewModelState(models: Pick<BoardModels, 'list'>, settings: Pick<ModelSettings, 'reviewModel'>): Promise<ReviewModelState> {
  const id = reviewModelInUse(settings);
  if (!id) return { state: 'none' };
  const model = (await models.list()).find(m => m.id === id);
  return model ? { state: 'ready', model } : { state: 'unavailable', id };
}

/** The fixed message of the check after a pick: it holds no email text. */
export const MODEL_CHECK_PROMPT = 'Reply with the single word: ready';

export type ModelCheck = { ok: true; modelId: string } | { ok: false; modelId: string; error: string };

/** Makes one short call to the model, so the developer sees whether it answers from a board. Logs the model and the outcome only. */
export async function checkModelAnswers(models: BoardModels, id: string, onDiag?: DiagLogger): Promise<ModelCheck> {
  try {
    await models.send(id, MODEL_CHECK_PROMPT);
    onDiag?.('info', 'A board called a language model', { modelId: id, outcome: 'answered' });
    return { ok: true, modelId: id };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: unknown } | undefined)?.code;
    onDiag?.('warn', 'A board could not call a language model', { modelId: id, outcome: 'failed', ...(typeof code === 'string' ? { code } : {}), error });
    return { ok: false, modelId: id, error };
  }
}

/** How a model is named to the developer. */
export function modelLabel(model: BoardModelInfo): string {
  return model.vendor ? `${model.name} (${model.vendor})` : model.name;
}

/** The email check's model as a board shows it: the one in use, the ones to pick from, or why none can be listed. */
export interface EmailModelChoice {
  inUse?: { id: string; label: string; source: ModelSource };
  options?: Array<{ id: string; label: string }>;
  problem?: string;
}

/** The model choice from the models listed (or the reason they could not be listed) and the settings. */
export function describeEmailModels(
  listed: { models: BoardModelInfo[] } | { problem: string }, settings: Pick<ModelSettings, 'emailModel' | 'reviewModel'>,
): EmailModelChoice {
  const choice: EmailModelChoice = {};
  const known = 'models' in listed ? listed.models : [];
  if ('problem' in listed) choice.problem = `The language models could not be listed: ${listed.problem}`;
  else if (known.length === 0) choice.problem = 'No language model is available in this VS Code. Sign in to GitHub Copilot to use the model check.';
  else choice.options = known.map(m => ({ id: m.id, label: modelLabel(m) }));
  const inUse = emailModelInUse(settings);
  if (inUse) {
    const model = known.find(m => m.id === inUse.id);
    choice.inUse = { id: inUse.id, label: model ? modelLabel(model) : inUse.id, source: inUse.source };
  }
  return choice;
}
