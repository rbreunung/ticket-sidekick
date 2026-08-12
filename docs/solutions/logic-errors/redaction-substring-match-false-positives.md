---
title: Substring-based key redaction falsely redacts non-secret fields (authType, maxInputTokens)
date: 2026-08-12
category: logic-errors
module: diagnostics/logRedaction
problem_type: logic_error
component: tooling
symptoms:
  - "authType is logged as [REDACTED] on the connection-check failure diagnostic line, hiding whether the failure was Data Center or Cloud auth"
  - "maxInputTokens is logged as [REDACTED] on the model-in-use info line, hiding the actual context budget used for a review"
  - Non-secret config/count fields are redacted purely because their key contains the substring auth or token
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components: [diagLog, JiraParticipant, BitbucketParticipant, TicketService]
tags: [redaction, logging, diagnostics, false-positive, regex, substring-match, word-boundary, output-channel]
---

# Substring-based key redaction falsely redacts non-secret fields (authType, maxInputTokens)

## Problem

`sanitizeDetails()` in `src/utils/logRedaction.ts`, which auto-redacts secret-looking keys before a diagnostic `details` payload is written to the shared "Ticket Sidekick" Output Channel (`logDiag()` in `src/utils/diagLog.ts`), matched sensitive keys with a bare substring regex. This silently redacted two non-secret, high-value diagnostic fields — `authType` and `maxInputTokens` — on precisely the two log lines the whole feature exists to make useful.

## Symptoms

- The Jira connection-check failure log line (`src/participant/JiraParticipant.ts:108`, `logDiag('jira.participant', 'error', 'Jira connection check failed', { baseUrl: config.baseUrl, authType: config.authType, error: message })`) and the equivalent Bitbucket line (`src/participant/BitbucketParticipant.ts:266`) wrote `"authType":"[REDACTED]"` to the Output Channel instead of `cloud` or `datacenter` — the single most useful field for diagnosing *why* a connection failed (wrong auth mode is a common misconfiguration) was hidden.
- The Bitbucket "model in use" INFO line (`src/participant/BitbucketParticipant.ts:584-590`, logged right after `getPullRequest` succeeds) wrote `"maxInputTokens":"[REDACTED]"` instead of the actual context-window size (e.g. `128000`), making it impossible to tell from the log whether an unusually small/large model was in play when diagnosing a chunking or truncation issue.
- No error, crash, or test failure — the log simply contained a placeholder where a maintainer expected a real value. Only caught by a human deliberately re-running the redaction regex against real key names used elsewhere in the diff, as instructed by a final whole-branch review pass.

## What Didn't Work

The original implementation (now superseded, previously at `src/utils/logRedaction.ts`):

```ts
const SENSITIVE_KEY_PATTERN = /token|auth|password|secret|credential|bearer|apikey/i;
```

used inside `sanitizeObject` as:

```ts
if (SENSITIVE_KEY_PATTERN.test(key)) {
  result[key] = '[REDACTED]';
  continue;
}
```

This is a bare substring test — `/auth/i` matches anywhere in the key, so `authType` (`auth` + `Type`) and `maxInputTokens` (`max` + `Input` + `Tokens`, containing `token` as a substring of `Tokens`) both matched and were redacted, despite neither being a secret.

The unit tests shipped alongside this code (`src/test/logRedaction.test.ts`, first two `it` blocks as of the pre-fix commit) only checked:
- Clearly-sensitive keys: `token`, `authorization`, `password`, `apiKey` → expected `[REDACTED]`
- Clearly-unrelated keys: `count`, `fileName` → expected untouched

There was no adversarial/near-miss case — no key that *contains* a sensitive substring but *isn't* sensitive (`authType`, `maxInputTokens`, `author`). The test suite exercised only the two extremes of the input space, so it passed even though the matching logic was fundamentally too broad. It also passed its individual per-task code review, because reviewing that task in isolation had no reason to cross-reference key names used in *other* tasks of the same branch (`authType` is logged in the participant files; `maxInputTokens` in the Bitbucket participant's model-diagnostic line — neither task touched `logRedaction.ts` directly). The gap was only found when a final whole-branch reviewer was explicitly told to run the regex against real key names from the rest of the diff rather than trust the shipped unit tests.

## Solution

Fixed in `b5f3648` ("fix(diag): word-boundary-aware key redaction; truncate message; skip empty details") on branch `feature/diagnostic-logging-expansion`, part of PR #31 (open as of this writing, not yet merged to `main`).

Current `src/utils/logRedaction.ts:8-27`:

```ts
const SENSITIVE_WORDS = new Set(['token', 'authorization', 'password', 'secret', 'credential', 'bearer']);

/**
 * A key is sensitive if it exactly equals one of the known secret-shaped
 * words after splitting on case/separator boundaries (so "authToken" and
 * "api_key" redact, but "authType" and "maxInputTokens" — which merely
 * contain "auth"/"token" as a substring — do not). "apiKey" is handled as
 * a special compound case rather than by adding the generic word "key" to
 * SENSITIVE_WORDS, which would incorrectly redact fields like "issueKey".
 */
function isSensitiveKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
  if (words.some((w) => SENSITIVE_WORDS.has(w))) return true;
  const collapsed = key.toLowerCase().replace(/[_-]/g, '');
  return collapsed.includes('apikey');
}
```

...and the call site at `src/utils/logRedaction.ts:58` now reads `if (isSensitiveKey(key)) {` in place of the old `if (SENSITIVE_KEY_PATTERN.test(key)) {`.

Two adversarial regression tests were added to `src/test/logRedaction.test.ts:58-70`:

```ts
it('does not redact keys that merely contain a sensitive word as a substring', () => {
  const result = sanitizeDetails({ authType: 'cloud', maxInputTokens: 8000, author: 'Jane' });
  expect(result.authType).toBe('cloud');
  expect(result.maxInputTokens).toBe(8000);
  expect(result.author).toBe('Jane');
});

it('still redacts compound keys ending in a sensitive word', () => {
  const result = sanitizeDetails({ authToken: 'xyz', apiToken: 'abc', api_key: 'def' });
  expect(result.authToken).toBe('[REDACTED]');
  expect(result.apiToken).toBe('[REDACTED]');
  expect(result.api_key).toBe('[REDACTED]');
});
```

(The same commit also fixed two related issues in `src/utils/diagLog.ts`: it now truncates the `message` param the same way `details` was already truncated, since an unbounded raw API error message could previously dump unbounded HTML/JSON into the channel; and it skips writing an empty `{}` details line.)

## Why This Works

`SENSITIVE_KEY_PATTERN.test(key)` is a substring test: `/auth/i` fires whenever the three-letter sequence "auth" appears *anywhere* in the key, with no regard for word boundaries — so `authType`, `authenticate`, `unauthorized` would all match despite being semantically unrelated to "this key holds an authorization token."

`isSensitiveKey()` instead **tokenizes** the key on camelCase (`([a-z0-9])([A-Z])` boundary) and snake_case/kebab-case (`_`/`-`) separators, lowercases each resulting word, and checks **exact set membership** (`SENSITIVE_WORDS.has(w)`) rather than substring containment. `authType` splits into the words `["auth", "type"]` — neither of which is the literal word `authorization` (note `auth` itself was deliberately *not* added to `SENSITIVE_WORDS`, since keeping it would still incorrectly flag `authType`: `auth` alone is too generic a fragment to trust as a signal). `maxInputTokens` splits into `["max", "input", "tokens"]` — the set contains the singular `token`, and `tokens` (plural) is a different string, so it also correctly avoids a match; even if pluralization weren't the deciding factor here, the underlying principle is that whole-word equality, not fragment containment, is what should gate redaction.

The `apiKey`/`api_key` compound case is handled separately via a collapsed-lowercase-string `.includes('apikey')` check rather than by adding the bare word `key` to `SENSITIVE_WORDS`. Adding `key` as a standalone sensitive word would have caused any key containing the word "key" to redact — including `issueKey`, which is logged routinely throughout the codebase (e.g. `src/services/TicketService.ts:533`, the bulk-update failure log: `this.onDiag?.('warn', ..., { issueKey: key, fieldId, error: message })`). Since `issueKey` is a Jira ticket identifier, not a credential, redacting it would have broken diagnostics the same way `authType` and `maxInputTokens` did. Checking for the specific compound `apikey` string (after stripping separators) redacts `apiKey`/`api_key` while leaving unrelated `*Key`/`*_key` fields alone.

## Prevention

- When writing a name-based allow/deny-list heuristic (redaction, feature-flag targeting, routing-by-name, permission checks by key/field name — anything that decides behavior from a string identifier), **test it against the real field/key names already used in the codebase**, not just synthetic examples chosen to be obviously-in or obviously-out. Grep the codebase for existing identifiers before finalizing the pattern, the way the final reviewer did here (`grep -rn "authType" src/participant/`, `grep -rn "maxInputTokens" src/participant/`).
- Prefer **whole-word / word-boundary matching** over raw substring matching for any "does this identifier look like X" check. A bare `/keyword/i.test(str)` regex will false-positive on any longer identifier that happens to contain the keyword as a substring (`auth` inside `authType`, `token` inside `maxInputTokens`/`Tokens`). Split on case/separator boundaries and compare whole tokens instead — as done in `isSensitiveKey()` (`src/utils/logRedaction.ts:18-27`).
- Add adversarial "near-miss" test cases as a standing category alongside happy-path/unrelated cases whenever writing this kind of heuristic — see the two new tests in `src/test/logRedaction.test.ts:58-70`: one proving substring-only matches are correctly *not* redacted (`authType`, `maxInputTokens`, `author`), one proving genuine compound matches are still redacted (`authToken`, `apiToken`, `api_key`). A test suite that only covers "obviously yes" and "obviously no" cases will pass even when the matching logic is fundamentally too broad or too narrow.
- A per-task or per-file code review is structurally unable to catch this kind of cross-cutting false positive, because the colliding field names (`authType`, `maxInputTokens`) live in files the redaction logic's own task never touches. Keep (or introduce) a final whole-branch review pass that is explicitly instructed to verify security/redaction/allow-deny-list claims empirically — e.g. "run the actual matcher against real identifiers used elsewhere in this diff" — rather than trusting that the feature's own unit tests prove the claim.

## Related Issues

- No pre-existing `docs/solutions/` entries — this is the first learning captured in this repo with `ce-compound`.
- Fix shipped as part of PR [#31](https://github.com/rbreunung/ticket-sidekick/pull/31) ("Diagnostic logging expansion"), open as of this writing.
