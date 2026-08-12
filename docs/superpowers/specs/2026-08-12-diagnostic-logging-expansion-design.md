# Diagnostic Logging Expansion — Design

**Date:** 2026-08-12
**Status:** Approved

## Context

The Bitbucket review pipeline recently gained a shared VS Code Output
Channel (`"Ticket Sidekick"`, `src/utils/diagLog.ts`) used for two things:
LLM retry-attempt failures and the model-in-use line. It's proven useful,
but it's wired into exactly one subsystem. Everywhere else in the extension
(both `@jira` and the rest of `@bitbucket`), errors either surface only in
the ephemeral chat transcript or are silently swallowed with a fallback
(e.g. `.eml` deletion after import, `.gitignore` updates, template-reload
fallbacks) — nothing persists for a user or maintainer to look back at when
diagnosing an intermittent or hard-to-reproduce failure.

Goal: extend the same Output Channel to cover the whole application — all
relevant activities (major operations plus meaningful pipeline sub-steps)
and especially all errors — so a user hitting a problem can open
View → Output → "Ticket Sidekick" and get a persistent, readable record, and
so bug reports that include that output are actually diagnostic.

Investigation confirmed the codebase is a good fit for a direct extension of
the existing pattern: zero raw `console.*` calls anywhere, ~36 non-test
files across `src/participant/`, `src/services/`, `src/jira/`,
`src/bitbucket/`, `src/utils/`, and ~40-50 `catch` blocks that currently
fall into "shown to chat only" or "silently swallowed" — small enough to do
in one coordinated pass rather than phasing by subsystem.

**Key constraint discovered during investigation:** `TicketService.ts`,
`PrReviewService.ts`, `JiraApiClient.ts`, and `BitbucketApiClient.ts` do
**not** import `vscode` — that's exactly what keeps them loadable by Vitest
today (`ConfigService.ts` is the only file in `src/services/` that imports
`vscode`). `diagLog.ts` imports `vscode` to create the Output Channel, so
these four files cannot call `logDiag` directly without breaking their
existing unit test suites. The design threads an optional injected logger
callback into them instead — the same shape `lmRetry.ts` already uses for
its `onAttemptFailed` hook, so this extends a pattern already proven in this
codebase rather than introducing a new one.

## Non-goals

- No new user-facing setting (e.g. a log-level toggle). Logging is
  always-on at full detail — considered and explicitly declined to keep
  this change simple.
- No wrapper/decorator layer (`withLogging(scope, fn)`) or event-bus
  abstraction. Both were considered and rejected: this codebase has no
  existing DI/wrapper convention (`TicketService`/`PrReviewService` call
  `IJiraClient`/`IBitbucketClient` directly per the three-layer
  architecture), and there is currently exactly one log sink (the Output
  Channel), so an event bus buys nothing today. If a second sink (e.g.
  telemetry) is ever needed, it can be added inside `logDiag` later without
  touching any of the ~40-50 call sites, since they all depend only on the
  `logDiag(scope, level, message, details?)` signature.
- Not every `catch` block gets a log line. Expected, high-frequency internal
  control flow that isn't diagnostic signal (e.g. `reviewSessionState.ts`'s
  streaming partial-JSON parse retries) is deliberately excluded.

## Design

### 1. `logDiag` gains a level; a pure type module makes it injectable

New file `src/utils/diagTypes.ts` (no `vscode` import):

```ts
export type LogLevel = 'info' | 'warn' | 'error';
export type DiagLogger = (level: LogLevel, message: string, details?: Record<string, unknown>) => void;
```

`src/utils/diagLog.ts` changes `logDiag` to
`logDiag(scope: string, level: LogLevel, message: string, details?: Record<string, unknown>)`,
writing `[ISO-timestamp] [LEVEL] [scope] message` (+ a JSON details line
when given). The 2 existing call sites in `BitbucketParticipant.ts` (the
`logLmFailure` helper at line ~63, and the model-in-use log at line ~567)
gain a level argument (`'error'` and `'info'` respectively) — no other
behavior change there.

### 2. Redaction/truncation is centralized and pure

New file `src/utils/logRedaction.ts` (no `vscode` import, fully
Vitest-testable): `sanitizeDetails(details: Record<string, unknown>): Record<string, unknown>`

- Recursively walks the object (capped depth, e.g. 4) and any arrays (capped
  length, e.g. 20 items, with a "…N more" marker for the rest)
- Any key matching `/token|auth|password|secret|credential|bearer|apikey/i`
  → value replaced with `'[REDACTED]'`
- Any string value over ~500 chars → truncated with a
  `"…[truncated, N chars total]"` suffix

`logDiag` calls `sanitizeDetails` internally right before
`JSON.stringify(details)` — every call site gets this for free, no call
site needs to remember it. This is what makes it safe to pass ticket
bodies, PR diffs, or email content through `details` for sub-step logging.

### 3. Two ways to log, decided by whether the file already imports `vscode`

- **Direct `logDiag` calls** — for every file that already imports
  `vscode`: `JiraParticipant.ts`, `BitbucketParticipant.ts`,
  `extension.ts`, `ConfigService.ts`, and all of
  `src/participant/jira/*Handler.ts` (`fieldHandler.ts`,
  `veracodeHandler.ts`, `createHandler.ts`, `emailHandler.ts`,
  `cleanupHandler.ts`, `loadHandler.ts`, `ticketContext.ts`,
  `workflowHandler.ts`, `contentHandler.ts`). This is the majority of the
  ~40-50 catch sites.
- **Injected `onDiag?: DiagLogger`** — for the 4 files that don't import
  `vscode` and must stay that way:
  - `TicketService` and `PrReviewService`: add an optional second
    constructor parameter, e.g.
    `constructor(private readonly client: IJiraClient, private readonly onDiag?: DiagLogger) {}`.
    Existing `new TicketService(client)` / `new PrReviewService(client)`
    calls and every existing test keep working unchanged (defaults to
    `undefined`; call sites use `this.onDiag?.(...)`).
  - `JiraApiClient` / `BitbucketApiClient`: add an optional
    `onDiag?: DiagLogger` field to `JiraApiClientConfig` / the Bitbucket
    equivalent config object (both clients already take a single config
    object in their constructor), same optional/no-op-by-default shape.
  - The real instantiation sites (in `extension.ts` / the participants)
    pass a bound logger, e.g.
    `new TicketService(client, (level, msg, details) => logDiag('jira.ticketService', level, msg, details))`.

### 4. Scope taxonomy — one tag per file/layer

Mirrors the existing `bitbucket.review` convention (the *message* text
distinguishes the specific operation, not the scope):

`jira.participant`, `jira.create`, `jira.field`, `jira.cleanup`,
`jira.workflow`, `jira.email`, `jira.veracode`, `jira.load`, `jira.content`,
`jira.ticketService`, `jira.apiClient`, `bitbucket.review` (existing),
`bitbucket.followup`, `bitbucket.prReviewService`, `bitbucket.apiClient`,
`config`, `extension`.

### 5. What gets a log line (the pattern — applied consistently, not enumerated line-by-line)

- **ERROR** — every catch that today only shows a message in chat, or
  silently swallows a real failure, also calls `logDiag`/`onDiag` at
  `'error'`. User-facing behavior is unchanged (same chat message, same
  fallback) — it just also becomes persistent. Representative examples
  found during investigation: the per-session catch blocks throughout
  `JiraParticipant.ts` (cleanup batch, filter selection, field update,
  content preview, bulk update, etc. — ~17 sites) and
  `BitbucketParticipant.ts` (review/refinement/follow-up LLM failures —
  ~8 sites).
- **WARN** — non-fatal fallback paths that let the operation continue.
  Representative examples: `emailHandler.ts` `.eml` deletion after import
  (currently a bare `.catch(() => {})`), `loadHandler.ts` `.gitignore`
  update after attachment download, `createHandler.ts`
  template-reload-on-continuation fallback, the Cloud diff JSON-parse
  fallback in `BitbucketApiClient.ts`.
- **INFO (major operations)** — one line per completed user-facing
  operation: ticket created/updated/commented (`TicketService`), PR review
  completed (`PrReviewService`/`BitbucketParticipant`), cleanup batch
  executed (with counts), email/veracode import completed, workflow
  discovered.
- **INFO (sub-steps)** — meaningful pipeline progress, mostly in
  `PrReviewService` where the actual review pipeline logic lives: LLM retry
  attempts (already exists), chunk N/M sent, additional-files-fetched
  count, critic-pass drop count, JQL search result count.

### 6. Testing

- `sanitizeDetails` (new, pure): full Vitest coverage — redaction
  key-matching (positive and negative cases), truncation boundary, nested
  objects, arrays.
- `logDiag` itself: stays e2e-only, same as today (touches `vscode`, not
  loadable by Vitest) — no change to that constraint.
- `TicketService`/`PrReviewService`/`JiraApiClient`/`BitbucketApiClient`
  changes are additive optional params — no existing test needs
  modification. New tests assert `onDiag` fires with the expected
  level/message/details on the paths being instrumented (constructing the
  service with a spy callback in place of the client mock's second arg).

## Files changed

| File | Change |
| --- | --- |
| `src/utils/diagTypes.ts` (new) | `LogLevel`, `DiagLogger` types |
| `src/utils/logRedaction.ts` (new) | `sanitizeDetails()` — pure, unit-tested |
| `src/utils/diagLog.ts` | `logDiag` gains `level` param + calls `sanitizeDetails` |
| `src/participant/BitbucketParticipant.ts` | update 2 existing `logDiag` calls for new signature; add direct logging to its own catch sites (`bitbucket.followup`, `bitbucket.review`); wire `onDiag` into `PrReviewService`/`BitbucketApiClient` instantiation |
| `src/participant/JiraParticipant.ts` | direct logging (`jira.participant`) at its catch sites; wire `onDiag` into `TicketService`/`JiraApiClient` instantiation |
| `src/participant/jira/*Handler.ts` (9 files) | direct logging at each handler's catch sites, scoped per file (`jira.create`, `jira.field`, etc.) |
| `src/services/TicketService.ts` | optional `onDiag` constructor param; INFO on major ops, ERROR on its 2 existing catch sites |
| `src/services/PrReviewService.ts` | optional `onDiag` constructor param; INFO on major ops + sub-steps, ERROR on its 2 existing catch sites |
| `src/jira/JiraApiClient.ts` | optional `onDiag` config field; WARN on its deliberate-swallow catches (404 remote links, non-Scrum board skip) |
| `src/bitbucket/BitbucketApiClient.ts` | optional `onDiag` config field; WARN on the Cloud diff JSON-parse fallback |
| `src/extension.ts` | direct logging at its catch sites (`extension` scope); wire loggers into service/client construction if instantiated here |
| `src/services/ConfigService.ts` | direct logging where relevant (`config` scope) |
| `CLAUDE.md` | Add `diagTypes.ts`/`logRedaction.ts` to the key files table; update the `diagLog.ts`/`logDiag()` description (new `level` param); note the injected-`onDiag` pattern alongside the existing `lmRetry.ts` description |

No changes needed to `package.json` (`contributes.configuration`) — no new
setting.

## Verification

1. `npm run compile` — TypeScript type check passes (new optional params,
   new files, signature change to `logDiag` propagated everywhere).
2. `npm test` — full Vitest suite green, including new tests for
   `sanitizeDetails` and the `onDiag` wiring in `TicketService`/
   `PrReviewService` (and `JiraApiClient`/`BitbucketApiClient` if their test
   files support constructing with the extra config field).
3. Manual smoke check via `npm run test:e2e` or a dev-host run: trigger a
   real failure path (e.g. bad Jira token) and a real success path (e.g.
   create a ticket against the mock/dev instance), then open
   View → Output → "Ticket Sidekick" and confirm both a persistent ERROR
   line and an INFO line appear with the expected scope/level/message, and
   that no raw secret or oversized content shows up in the details line.
