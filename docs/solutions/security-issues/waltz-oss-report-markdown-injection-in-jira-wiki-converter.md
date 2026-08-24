---
title: Backslash-Escaping Doesn't Sanitize Input for markdownToJiraWiki()
date: 2026-08-13
last_updated: 2026-08-24
category: security-issues
module: "Shared report-import sanitizer — sanitizeCellText()/sanitizeStandaloneLine() (src/utils/reportImport.ts), consumed by both the Veracode and Waltz importers' buildDescriptionWiki()"
problem_type: security_issue
component: assistant
symptoms:
  - "ce-code-review security-persona pass flagged a P1: untrusted .xlsx cell values (component names, CVE summaries, artifact paths) are interpolated unsanitized into a Markdown string used to build the ticket description"
  - "A crafted component name or CVE summary could inject a Markdown heading, table row, or link into the generated Jira ticket description"
  - "First fix attempt (a backslash-escaping helper, escapeMarkdown()) provided zero actual protection: markdownToJiraWiki() has no escape awareness anywhere in its ~127-line implementation"
  - "A backslash-escaped table pipe still split the table cell, because rows are parsed via a raw line.slice(1,-1).split('|') with no escape-consumption"
  - "Backslash-escaped bold/italic/code/link markers still triggered inline() regex formatting, because the regexes have no lookbehind or backslash check — a backslash before a heading '#' at line start still matched the heading regex too"
  - "(2026-08-14 update) A later 9-persona code review's security persona found a third, distinct gap this doc's own 'Related Issues' section had predicted but left unfixed: sanitizeCellText() stripped only Markdown's trigger characters, never Jira's own native wiki-markup trigger characters, which markdownToJiraWiki() also never neutralizes since it only recognizes Markdown syntax and passes anything else through unchanged"
  - "(2026-08-14 update) Concrete exploit: an attacker-controlled field containing '!https://attacker.example/t.gif!' (Jira-native remote-image embed) survived unsanitized and rendered as a live, auto-loading tracking pixel in the created ticket"
root_cause: missing_validation
resolution_type: code_fix
severity: critical
related_components: [tooling, documentation]
tags: [waltz-oss-report, veracode, markdown-injection, jira-wiki-converter, jira-native-wiki-markup, sanitization, untrusted-input, code-review-finding, xlsx-import, tracking-pixel, security]
---

# Backslash-Escaping Doesn't Sanitize Input for markdownToJiraWiki()

## Problem

`buildDescriptionWiki()` in `src/utils/waltzReport.ts` (src/utils/waltzReport.ts:271-320) builds a Jira ticket description by string-interpolating untrusted `.xlsx` cell values (component name, CVE id/summary, artifact paths, CVE severity/fixed-version) into Markdown lines, then converting the whole thing to Jira wiki markup in a single `markdownToJiraWiki(lines.join('\n'))` call (src/utils/waltzReport.ts:319). A `ce-code-review` security-persona pass flagged this as P1: a crafted CVE summary or component name in the report could inject a Markdown heading, table row, or link into the generated description, because nothing neutralized Markdown-structural characters in those values before the conversion.

## Symptoms

A component or vulnerability row containing Markdown-structural characters (`#`, `|`, `[...]`, `*`, `_`, a raw newline) in a spreadsheet-derived field — most plausibly a CVE summary, since that's free text pulled from an external vulnerability database and never validated — would render as structurally different content in the created Jira ticket than what appeared in the source cell. Concretely: a CVE summary containing an embedded `\n# Fake Heading` would produce a fabricated `h1.` heading in the ticket description (rather than a title-cased sentence fragment inline with the rest of the summary); an embedded `| a | b |` line would produce an extra `||a||b||` table row; `[click me](http://evil.example)` would render as a live, clickable `[click me|http://evil.example]` Jira link; and a literal `|` inside a value meant to occupy one table cell (e.g. an `Overall Severity` value of `High | Critical`) would misalign the "Known vulnerabilities" table by splitting into an extra cell. None of this would throw an error or fail a test — the ticket would simply be created with attacker-influenced structure and a clickable link, which a reviewer would only catch by reading the rendered ticket description in Jira, not by looking at test output.

## What Didn't Work

The first fix attempt was `escapeMarkdown()`: a helper that prefixed Markdown-structural characters (`|`, `#`, `[`, `]`, `*`, `_`, backtick) with a literal backslash, on the standard-CommonMark assumption that a backslash-pipe renders as a literal pipe, a backslash-asterisk as a literal asterisk, and so on. This is the normal, correct way to neutralize Markdown metacharacters against a real Markdown parser — but it was never tested against what `markdownToJiraWiki()` actually does, and reading the converter's implementation end to end (src/utils/markdownToJiraWiki.ts) showed it has zero backslash/escape awareness anywhere:

- **Table cells**: the "Table row" branch does `line.slice(1, -1).split('|')` (src/utils/markdownToJiraWiki.ts:79) — a raw string split with no escape-consumption. A value containing a backslash-escaped pipe still splits into two cells; the backslash just becomes a stray literal character sitting in one half.
- **Inline formatting**: all bold/italic/code-span/link handling happens in the separate `inline()` helper (as of the 2026-08-24 Jira-native-trigger-neutralization fix, `src/utils/markdownToJiraWiki.ts:176-235` — line numbers shifted after that later fix added ~85 lines of neutralization logic before `inline()`; at the time of this doc's original 2026-08-13 investigation it was `:93-127`) via regexes matched directly against raw text — e.g. `` /`([^`]+)`/g `` for code spans (line 96), `/\*\*(.+?)\*\*/g` for bold (line 111), `/\*([^*\n]+)\*/g` for italic (line 115), and `/\[([^\]]+)\]\(([^)]+)\)/g` for links (line 108). None of these have a negative-lookbehind or any other "don't match if preceded by a backslash" logic. A value like a backslash-wrapped `*injected*` still matches the italic regex and still gets wrapped in Jira wiki markup — the backslash is not consumed, it just sits next to the markup as a stray extra character.
- **Headings**: recognized by `/^(#{1,6})\s+(.+)$/` matched against each raw line (src/utils/markdownToJiraWiki.ts:26), evaluated at the very top of the line loop before any inline-level processing (and therefore before any escape handling) could apply. A value whose line starts with `# ` becomes an `h1.`-`h6.` heading regardless of a leading backslash.

Net effect: every character `escapeMarkdown()` "escaped" would still trigger the exact parsing it was meant to prevent, plus leave a visible stray backslash in the output. The injection the code review flagged would have survived this fix completely unchanged; it was caught only because the engineer read the converter's source before finalizing, rather than trusting the general CommonMark-escaping assumption.

## Solution

`escapeMarkdown()` was discarded entirely (never landed) and replaced with `sanitizeCellText()` — character replacement/removal, not escaping — tailored to exactly the three parsing hooks identified above (src/utils/waltzReport.ts:260-265):

```ts
// Failed approach (never committed) — backslash-escaping:
function escapeMarkdown(value: string): string {
  return value.replace(/([|#\[\]*_`])/g, '\\$1');
}

// Actual fix — src/utils/waltzReport.ts:260-265
function sanitizeCellText(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, ' ')   // can't start a new line -> can't become its own heading/table row/etc.
    .replace(/\|/g, '/')            // can't split a table cell
    .replace(/[*_`[\]]/g, '');      // removes every character bold/italic/code-span/link syntax needs to match at all
}
```

Every untrusted interpolation point inside `buildDescriptionWiki()` is now wrapped in `sanitizeCellText(...)` before being pushed onto the `lines` array (src/utils/waltzReport.ts:271-320): the max vuln rating (line 276), the top CVE's id and summary (line 285), each affected artifact path (line 294), each CVE row's id/severity/fixed-version (line 308), and the component name/version (line 317). The `lines` array is still joined and converted exactly once at the end via `markdownToJiraWiki(lines.join('\n'))` (line 319) — the fix is entirely in what goes into the array, not in how it's converted.

Two tests in `src/test/waltzReport.test.ts` verify this closes the hole end-to-end:
- `'neutralizes markdown-structural characters in untrusted cell content so a crafted CVE summary cannot inject a heading, table row, link, or bold/italic text'` (src/test/waltzReport.test.ts:239-261) — feeds a CVE summary of `'Injected\n# Fake Heading\n| a | b |\n[click me](http://evil.example) *bold*'` through `buildDescriptionWiki()` and asserts the output contains none of `'h1. Fake Heading'`, `'||a||b||'`, `'[click me|http://evil.example]'`, or `'*bold*'`.
- `'replaces a literal pipe in a table-cell value so it cannot split the Known vulnerabilities table row'` (src/test/waltzReport.test.ts:263-279) — sets `overallSeverity` to `'High | Critical'` and asserts the rendered table row is the single well-formed `|CVE-2099-0001|High / Critical|7|n/a|` rather than a split/misaligned row.

## Why This Works

`markdownToJiraWiki()` has no escape-consumption logic anywhere in its ~127 lines (src/utils/markdownToJiraWiki.ts) — not in the heading check, not in the table-row split, not in any of `inline()`'s regexes. It is a line-based/regex-based recognizer, not a parser with an escaping grammar: it decides "this is a heading / table row / bold span" purely by testing whether a *character* is present at a given position, never by testing whether that character is preceded by a backslash. Escaping (prefixing a backslash) only works as a defense against a parser that has been built to *consume* that backslash and suppress the match — this converter was never built with that feature, so a backslash-prefixed structural character still matches every rule the same as an unprefixed one, and the backslash itself becomes stray leftover text. `sanitizeCellText()` works instead because it removes the actual signal the parser keys on (the newline that starts a new logically-independent line, the `|` that `split('|')` breaks on, the `#`/`*`/`_`/`` ` ``/`[`/`]` characters the regexes require to match at all) rather than trying to tell the parser "don't treat this as structure" — there is no channel through which to tell it that, so the only reliable defense is to make the trigger characters not present in the first place. This same bracket-stripping incidentally also closes the image/thumbnail vector — `inline()`'s image regex (`src/utils/markdownToJiraWiki.ts:190` as of the 2026-08-24 fix; `:103` at this doc's original writing) turns Markdown image syntax (an exclamation mark, then bracketed alt text, then a parenthesized URL) into a Jira `!url!` or `!url|thumbnail!` reference, and that regex requires literal `[`/`]` around the alt text, so once those are stripped a sanitized value can never reconstruct the shape needed to trigger it, even though nothing in `sanitizeCellText()` was written with images specifically in mind.

## Residual Risk (Resolved 2026-08-14)

The two gaps originally recorded in this section are both closed as of the report-importer consolidation refactor (branch `refactor/consolidate-report-importers`), before the Jira-native-trigger fix below:

- **Strikethrough (`~~text~~`)** — closed by adding `~` to `sanitizeCellText()`'s stripped-character set.
- **Line-start structural markup** (`maxVulnRating`, `nameVersion`, and equivalents) — closed by `sanitizeStandaloneLine()`, which prefixes every whole-line value with a literal `': '` so it can never occupy raw line-start position, regardless of which characters it contains. This is a structural fix (denying position), not a character-stripping one — it defeats the horizontal-rule/blockquote/list/heading checks named in the original write-up without needing to strip `-`, `>`, digits, or `.` directly.

**A third, distinct gap survived past both of those fixes and past the consolidation refactor itself** — this doc's own "Related Issues" section (below) had predicted its shape but it was never implemented, and it applied to the *shared* sanitizer both importers now use, not just one:

### Jira-native wiki-markup triggers bypassed the sanitizer entirely

`sanitizeCellText()`'s stripped-character set (`*_`\`[]~`, plus the earlier additions above) targets exactly the syntax `markdownToJiraWiki()` itself recognizes as Markdown. But the sanitized-then-converted string is not the final destination — `markdownToJiraWiki()`'s output is sent to Jira verbatim as the ticket's `description` field, and Jira's own renderer applies **its own, distinct wiki-markup syntax** to that string with no further transformation in between. `markdownToJiraWiki()`'s `inline()` fallback (`src/utils/markdownToJiraWiki.ts:176-235` as of the 2026-08-24 fix; `:93-127` at this doc's original writing) passed any text it didn't recognize as Markdown straight through unchanged at the time this section was written — so Jira-native syntax embedded in a sanitized value reaches Jira's renderer completely untouched by either layer.

Jira's native trigger set left open by the pre-2026-08-14 sanitizer: `-text-` (strikethrough — reachable by typing a bare hyphen-wrapped string; notably `inline()`'s own strikethrough handling, `/~~(.+?)~~/g` at `src/utils/markdownToJiraWiki.ts:211` as of the 2026-08-24 fix (`:118` at this doc's original writing), *converts into* this exact `-...-` form, so the shared visual effect the original `~~` fix closed was still reachable through a different literal input), `+text+` (underline), `^text^` (superscript), `??text??` (citation), `{quote}`/`{color}`/`{panel}`/`{code}`/`{noformat}` (macro block delimiters), and — the concrete exploit — `!url!` (remote image embed). Unlike Markdown's own image syntax — an exclamation mark, then bracketed alt text, then a parenthesized URL — which needs `[`/`]` (already stripped), Jira's `!url!` needs no brackets at all: an attacker-controlled Veracode `description`/`recommendation` field or Waltz `cveSummary`/`nameVersion` cell containing `!https://attacker.example/t.gif!` became a working tracking pixel, auto-loading on every view of the created ticket and leaking viewer IP/user-agent/view-timing with zero user interaction — the highest-severity concrete consequence found.

This surfaced when a 9-persona `ce-code-review` pass's `security` persona independently rediscovered it and quoted this doc's own "Related Issues" warning back as evidence, rather than through any test or runtime signal — no error, no crash; the only observable artifact is the rendered ticket in Jira itself.

**Fix** — extended the same `sanitizeCellText()` character class (`src/utils/reportImport.ts:192-197`, moved here from `waltzReport.ts` during the consolidation refactor):

```ts
// before
.replace(/[*_`[\]~]/g, '');
// after
.replace(/[*_`[\]~\-+^?{}!]/g, '');
```

Seven characters added — `-`, `+`, `^`, `?`, `{`, `}`, `!` — each keyed to one Jira-native trigger, per the same "remove, don't escape" strategy (Jira's renderer has no documented backslash-escape convention for its own wiki markup either, so there was nothing to escape *to* here either). `sanitizeStandaloneLine()` needed no separate change — it wraps `sanitizeCellText()` and inherits the fix automatically. Confirmed the `!` addition doesn't regress the existing Markdown image-syntax defense (already blocked by the `[`/`]` strip) and is purely defensive against the distinct bracket-free Jira form. As a side effect, this closes the `{{monospace}}` macro vector too, since both `{` and `}` are now stripped.

New crafted-payload tests cover the full trigger set end-to-end (parse → sanitize → convert), for every sanitized field in both importers' `buildDescriptionWiki()` — `src/test/reportImport.test.ts:8-60`, `src/test/veracodeReport.test.ts:216-330`, `src/test/waltzReport.test.ts:246-282`.

Fixed on branch `refactor/consolidate-report-importers`, merged via [PR #33](https://github.com/rbreunung/ticket-sidekick/pull/33) 2026-08-14.

**2026-08-24 update — a second, broader layer of protection now exists.** The fix above extended `sanitizeCellText()`'s character class, which protects only callers that route untrusted values through it before building Markdown — the report importers, specifically. `markdownToJiraWiki()` itself still had no equivalent guarantee, which left every other caller (content preview/refinement, email-to-ticket) unprotected. That gap is now closed at the shared-converter level: see `docs/solutions/security-issues/jira-native-wiki-trigger-neutralization-in-shared-markdown-converter.md` (fixed via [PR #38](https://github.com/rbreunung/ticket-sidekick/pull/38), merged 2026-08-24). Both layers stay in place — this doc's `sanitizeCellText()` fix still protects against a value breaking out of its slot in a hand-assembled Markdown template, a different failure mode than the render-safety guarantee the newer fix adds.

### Why this specific gap survived two careful sanitization passes

Both `markdownToJiraWiki()` and Jira's own renderer are separate sinks the sanitized string passes through in sequence, and neither has escape-character semantics — but they recognize **overlapping, not identical**, trigger sets (`*`, `_`, `~~`→`-...-` overlap; `+`, `^`, `??`, `{...}`, `!url!` are Jira-only). The earlier work correctly audited the *conversion-time* sink (what the converter itself recognizes) and treated that audit as sufficient. It wasn't — a sanitizer whose job is "make text safe to end up as X" has to enumerate X's actual, complete trigger set directly, not infer it from whatever intermediate format the text happens to pass through on the way to X. This is precisely the failure mode this doc's own Prevention section (below) had already predicted in the abstract ("it will silently stop being exhaustive again if the target parser ever gains new syntax") — it just took a second parser in the pipeline, not new syntax in the same one, to prove it.

A related, separate lesson: the Veracode importer inherited this sanitizer from Waltz's already-hardened pipeline during the same consolidation refactor that moved `sanitizeCellText()` into `src/utils/reportImport.ts`. It was reasonable to assume "hardened for one consumer" meant "hardened, full stop" — it didn't, because the function's completeness had only ever been verified against the sinks known at the time, and this doc's own "Related Issues" section (below) had explicitly flagged, but not yet acted on, that Veracode's original pipeline exposed a related-but-distinct risk. Sanitizer reuse by a new consumer is a re-verification trigger, not a free pass — worth re-checking completeness against the new consumer's actual downstream sink, even when the sanitizer already has a track record.

## Prevention

When sanitizing untrusted input that will be fed through a **custom or hand-written parser/renderer** (as opposed to a well-known, spec-compliant library), do not assume standard escape semantics — backslash-escaping, HTML-entity-escaping, `\uXXXX`-escaping, etc. — apply. Those conventions only neutralize a match if the parser was specifically built to recognize and consume the escape sequence and suppress its normal rule as a result. Before writing (or trusting) any escaping helper against such a parser: read the parser's actual matching logic — every regex, every `split()`, every "does this line start with X" check — and confirm each one has an escape-consumption branch. If it doesn't, escaping is not just ineffective, it's strictly worse than doing nothing extra: the escape character becomes stray leftover content in the output in addition to the injection still succeeding. In that case, sanitize by removing or substituting the specific characters/sequences each matching rule requires to fire at all (as `sanitizeCellText()` does here — newlines, `|`, and the inline-markup trigger set), not by prefixing them.

Concretely, verify any such sanitizer with a test that constructs one crafted value containing every trigger character/sequence relevant to the target format in one string (e.g. `'Injected\n# Fake Heading\n| a | b |\n[click me](http://evil.example) *bold*'`) and asserts the *rendered output* contains none of the structural markup that value could have produced (no `h1.` heading, no extra `||...||` table row, no live `[text|url]` link, no bold/italic wrapping) — plus a second, narrower test for any single high-value trigger character used inside your own generated structure (e.g. a literal `|` inside a value that must stay one table cell), asserting the surrounding structure you control stays intact. See `src/test/waltzReport.test.ts:239-261` and `:263-279` for the concrete pattern.

**(2026-08-14 update) When the sanitized value passes through more than one sink in sequence** — here, an intermediate converter (`markdownToJiraWiki()`) *and* the renderer that consumes its output (Jira itself) — build the crafted payload from the union of every sink's trigger set, not just the one closest to the sanitizer. `src/test/reportImport.test.ts:30-37`'s `'neutralizes every trigger character in one crafted payload at once'` test does this: one string combining both Markdown and Jira-native triggers, asserted against the sanitizer's own output rather than a downstream render, since by the time a second sink is in play the sanitizer's contract is "safe for every sink downstream," not just "safe for the next one."

The Residual Risk section above is exactly what that verification discipline missed the first two times: each fix covered every vector its own crafted payload happened to exercise, not literally every rule every downstream consumer has. Three sharper practices follow from that history:

- **Enumerate exhaustively, not representatively.** List every line-start check and every `inline()`-style regex the target parser implements — not just the ones your first crafted payload happens to trigger — and pay particular attention to any interpolation point where the untrusted value becomes an **entire line** by itself with no trusted prefix character, since that exposes it to every line-start rule at once, a strictly larger surface than a value embedded mid-line after trusted text.
- **When there are two sinks in sequence, enumerate both.** Sanitizing against the syntax an intermediate converter recognizes is necessary but not sufficient when the converter's own output is consumed by a second renderer with a different, only-partially-overlapping trigger set. Identify the *final* sink's complete syntax reference directly rather than inferring it from what the intermediate format happens to require.
- **Prefer an allowlist over a denylist where the field's legitimate values allow it.** `sanitizeCellText()` is a denylist (strip known-dangerous characters), which is exactly why the Residual Risk vectors above existed — the list wasn't exhaustive, and it will silently stop being exhaustive again if either downstream parser ever gains new syntax. For narrow fields like CVE ids, severities, version strings, and file paths — none of which need arbitrary Unicode/punctuation to stay useful — restricting to a known-safe character range (alphanumerics, spaces, a short punctuation allowlist) is more robust against parser evolution than enumerating what to strip.

## Related Issues

- `docs/solutions/logic-errors/redaction-substring-match-false-positives.md` — the only other existing solutions doc at this doc's original writing (2026-08-13); unrelated (a log-redaction key-matching bug, not an injection/sanitization issue). No overlap. Several more docs now exist under `docs/solutions/` (2026-08-24 update) — see the direct-successor entry below for the one that matters to this topic.
- `docs/solutions/security-issues/jira-native-wiki-trigger-neutralization-in-shared-markdown-converter.md` (2026-08-24 update, direct successor) — closes the same Jira-native-trigger exploit class at the shared-converter level (`markdownToJiraWiki()` itself), protecting every caller rather than just the report importers this doc's fix covers. See the "2026-08-24 update" note under "Fix" above.
- **Resolved (2026-08-14)** — this bullet originally warned that the sibling Veracode Detailed Report import wrote unsanitized, externally-sourced values directly into hand-authored Jira wiki markup with no `sanitizeCellText()`-equivalent step at all, and predicted that a future fix would need "a sibling sanitizer tuned to [Jira's own trigger] set, not a reused import of this one." Both halves of that prediction are now addressed differently than predicted, but the risk is closed: Veracode's `buildDescriptionWiki()` (`src/utils/veracodeReport.ts`) was rewritten to author Markdown and convert once via `markdownToJiraWiki()` — the same pipeline Waltz already used — rather than writing raw wiki markup by hand, and the shared `sanitizeCellText()` (`src/utils/reportImport.ts`) was itself extended with the Jira-native trigger set described in the "Resolved Risk" section above, so no sibling sanitizer was needed after all. See that section for the full fix.
