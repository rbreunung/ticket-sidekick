/**
 * Shared logging types — deliberately free of any `vscode` import so files
 * that must stay loadable by Vitest (TicketService, PrReviewService,
 * JiraApiClient, BitbucketApiClient) can depend on them without pulling in
 * `vscode` transitively. See `diagLog.ts` for the actual sink.
 */
export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Injected into vscode-free classes so they can emit diagnostic lines
 * without importing `diagLog.ts` directly. The real implementation is a
 * scope-bound wrapper around `logDiag`, built at the instantiation site
 * (e.g. `(level, msg, details) => logDiag('jira.ticketService', level, msg, details)`).
 */
export type DiagLogger = (level: LogLevel, message: string, details?: Record<string, unknown>) => void;
