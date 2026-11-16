import type { DiagLogger } from '../utils/diagTypes';

// The language models a board may call, without a chat request: the extension asks VS Code for the
// models the developer has, and calls the one a setting names. Which model is in use, the one-call
// check after a pick, and the setting names live here; the VS Code calls are bound in
// registerBoards.ts. vscode-free.

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

/** A cancellation the caller can set; the VS Code binding turns it into a cancellation token. */
export interface ModelCancel {
  readonly isCancellationRequested: boolean;
  onCancellationRequested?(listener: () => void): void;
}

export interface BoardModels {
  /** The models available to the developer; empty when none is. */
  list(): Promise<BoardModelInfo[]>;
  /** Sends one user message to the model with this id and returns the reply's text; throws when the model is not there or refuses. */
  send(id: string, prompt: string, cancel?: ModelCancel): Promise<string>;
}

/** The two model settings as they are now, and the write of a pick. */
export interface ModelSettings {
  emailModel(): string;
  reviewModel(): string;
  writeEmailModel(id: string): Promise<void>;
}

export type ModelSource = 'email' | 'review';

/** The model the email check uses: the email setting, else the review setting, else none. */
export function emailModelInUse(settings: Pick<ModelSettings, 'emailModel' | 'reviewModel'>): { id: string; source: ModelSource } | undefined {
  const email = settings.emailModel().trim();
  if (email) return { id: email, source: 'email' };
  const review = settings.reviewModel().trim();
  return review ? { id: review, source: 'review' } : undefined;
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
