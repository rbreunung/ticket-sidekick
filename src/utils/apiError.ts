/**
 * Base class for HTTP API failures, carrying the numeric `status` so callers can classify
 * errors (auth, not-found, rate-limited) without sniffing message strings. Subclassed per
 * service so `instanceof` can distinguish Jira from Bitbucket failures.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }

  get isAuth(): boolean { return this.status === 401; }
  get isNotFound(): boolean { return this.status === 404; }
  get isRateLimited(): boolean { return this.status === 429; }
}

export class JiraApiError extends ApiError {}
export class BitbucketApiError extends ApiError {}
