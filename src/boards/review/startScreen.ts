import { SessionError } from '../../sessions/sessionTypes';
import type { DiagLogger } from '../../utils/diagTypes';
import { parseReviewUrl } from './recipe';

// The start screen of a pull request review, opened from the Command Palette: a tab without a
// session that asks for the pull request's link and opens its review board. The board then stops on
// its first step, as every review does. vscode-free: opening the board is supplied by the host.

export const REVIEW_START_BOARD = 'review-start';
export const REVIEW_START_TITLE = 'Review a pull request';

export interface ReviewStartDeps {
  /** The setup hint while Bitbucket is not configured; undefined when it is. */
  bitbucketHint(): Promise<string | undefined>;
  /** Opens the review board of this pull request; `title` is the opened board's tab title. */
  openReview(input: { url: string }): Promise<{ ok: true; title: string } | { ok: false; reason: string }>;
  onDiag?: DiagLogger;
}

export interface ReviewStartView {
  /** The link as last given. */
  url: string;
  /** Why the link was not opened. */
  problem?: string;
  /** The Bitbucket setup hint, shown instead of Open while Bitbucket is not configured. */
  bitbucketHint?: string;
  /** The title of the board the last Open opened. */
  opened?: string;
}

export class ReviewStartScreen {
  private url = '';
  private problem?: string;
  private opened?: string;

  constructor(private readonly deps: ReviewStartDeps) {}

  /** Answers one request of the start screen's page. */
  async handle(op: string, body: Record<string, unknown>): Promise<ReviewStartView> {
    switch (op) {
      case 'view':
        return this.view();
      case 'open':
        return this.open(body.url);
      default:
        throw new SessionError(404, 'Unknown request.');
    }
  }

  private async open(input: unknown): Promise<ReviewStartView> {
    if (typeof input !== 'string') throw new SessionError(400, 'Invalid link.');
    this.url = input.trim().slice(0, 2000);
    this.problem = undefined;
    this.opened = undefined;
    const hint = await this.deps.bitbucketHint();
    if (hint) {
      this.problem = hint;
      return this.view();
    }
    const parsed = parseReviewUrl(this.url);
    if (!parsed.ok) {
      this.problem = parsed.reason;
      return this.view();
    }
    const opened = await this.deps.openReview({ url: parsed.recipe.url });
    if (opened.ok) {
      this.opened = opened.title;
    } else {
      this.problem = `The review was not opened: ${opened.reason}`;
      this.deps.onDiag?.('warn', 'The review board did not open from its start screen', { reason: opened.reason });
    }
    return this.view();
  }

  async view(): Promise<ReviewStartView> {
    const hint = await this.deps.bitbucketHint();
    return {
      url: this.url,
      ...(this.problem ? { problem: this.problem } : {}),
      ...(hint ? { bitbucketHint: hint } : {}),
      ...(this.opened ? { opened: this.opened } : {}),
    };
  }
}
