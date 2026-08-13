---
title: Backslash-Escaping Doesn't Sanitize Input for markdownToJiraWiki()
date: 2026-08-13
category: security-issues
module: Waltz OSS report import — ticket description generation (buildDescriptionWiki, src/utils/waltzReport.ts)
problem_type: security_issue
component: assistant
symptoms:
  - "ce-code-review security-persona pass flagged a P1: untrusted .xlsx cell values (component names, CVE summaries, artifact paths) are interpolated unsanitized into a Markdown string used to build the ticket description"
  - "A crafted component name or CVE summary could inject a Markdown heading, table row, or link into the generated Jira ticket description"
  - "First fix attempt (a backslash-escaping helper, escapeMarkdown()) provided zero actual protection: markdownToJiraWiki() has no escape awareness anywhere in its ~127-line implementation"
  - "A backslash-escaped table pipe still split the table cell, because rows are parsed via a raw line.slice(1,-1).split('|') with no escape-consumption"
  - "Backslash-escaped bold/italic/code/link markers still triggered inline() regex formatting, because the regexes have no lookbehind or backslash check — a backslash before a heading '#' at line start still matched the heading regex too"
root_cause: missing_validation
resolution_type: code_fix
severity: high
related_components: [tooling, documentation]
tags: [waltz-oss-report, markdown-injection, jira-wiki-converter, sanitization, untrusted-input, code-review-finding, xlsx-import, security]
---

# Backslash-Escaping Doesn't Sanitize Input for markdownToJiraWiki()

## Problem

`buildDescriptionWiki()` in `src/utils/waltzReport.ts` (src/utils/waltzReport.ts:271-320) builds a Jira ticket description by string-interpolating untrusted `.xlsx` cell values (component name, CVE id/summary, artifact paths, CVE severity/fixed-version) into Markdown lines, then converting the whole thing to Jira wiki markup in a single `markdownToJiraWiki(lines.join('\n'))` call (src/utils/waltzReport.ts:319). A `ce-code-review` security-persona pass flagged this as P1: a crafted CVE summary or component name in the report could inject a Markdown heading, table row, or link into the generated description, because nothing neutralized Markdown-structural characters in those values before the conversion.

## Symptoms

A component or vulnerability row containing Markdown-structural characters (`#`, `|`, `[...]`, `*`, `_`, a raw newline) in a spreadsheet-derived field — most plausibly a CVE summary, since that's free text pulled from an external vulnerability database and never validated — would render as structurally different content in the created Jira ticket than what appeared in the source cell. Concretely: a CVE summary containing an embedded `\n# Fake Heading` would produce a fabricated `h1.` heading in the ticket description (rather than a title-cased sentence fragment inline with the rest of the summary); an embedded `| a | b |` line would produce an extra `||a||b||` table row; `[click me](http://evil.example)` would render as a live, clickable `[click me|http://evil.example]` Jira link; and a literal `|` inside a value meant to occupy one table cell (e.g. an `Overall Severity` value of `High | Critical`) would misalign the "Known vulnerabilities" table by splitting into an extra cell. None of this would throw an error or fail a test — the ticket would simply be created with attacker-influenced structure and a clickable link, which a reviewer would only catch by reading the rendered ticket description in Jira, not by looking at test output.

## What Didn't Work

The first fix attempt was `escapeMarkdown()`: a helper that prefixed Markdown-structural characters (`|`, `#`, `[`, `]`, `*`, `_`, backtick) with a literal backslash, on the standard-CommonMark assumption that a backslash-pipe renders as a literal pipe, a backslash-asterisk as a literal asterisk, and so on. This is the normal, correct way to neutralize Markdown metacharacters against a real Markdown parser — but it was never tested against what `markdownToJiraWiki()` actually does, and reading the converter's implementation end to end (src/utils/markdownToJiraWiki.ts) showed it has zero backslash/escape awareness anywhere:

- **Table cells**: the "Table row" branch does `line.slice(1, -1).split('|')` (src/utils/markdownToJiraWiki.ts:79) — a raw string split with no escape-consumption. A value containing a backslash-escaped pipe still splits into two cells; the backslash just becomes a stray literal character sitting in one half.
- **Inline formatting**: all bold/italic/code-span/link handling happens in the separate `inline()` helper (src/utils/markdownToJiraWiki.ts:93-127) via regexes matched directly against raw text — e.g. `` /`([^`]+)`/g `` for code spans (line 96), `/\*\*(.+?)\*\*/g` for bold (line 111), `/\*([^*\n]+)\*/g` for italic (line 115), and `/\[([^\]]+)\]\(([^)]+)\)/g` for links (line 108). None of these have a negative-lookbehind or any other "don't match if preceded by a backslash" logic. A value like a backslash-wrapped `*injected*` still matches the italic regex and still gets wrapped in Jira wiki markup — the backslash is not consumed, it just sits next to the markup as a stray extra character.
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

`markdownToJiraWiki()` has no escape-consumption logic anywhere in its ~127 lines (src/utils/markdownToJiraWiki.ts) — not in the heading check, not in the table-row split, not in any of `inline()`'s regexes. It is a line-based/regex-based recognizer, not a parser with an escaping grammar: it decides "this is a heading / table row / bold span" purely by testing whether a *character* is present at a given position, never by testing whether that character is preceded by a backslash. Escaping (prefixing a backslash) only works as a defense against a parser that has been built to *consume* that backslash and suppress the match — this converter was never built with that feature, so a backslash-prefixed structural character still matches every rule the same as an unprefixed one, and the backslash itself becomes stray leftover text. `sanitizeCellText()` works instead because it removes the actual signal the parser keys on (the newline that starts a new logically-independent line, the `|` that `split('|')` breaks on, the `#`/`*`/`_`/`` ` ``/`[`/`]` characters the regexes require to match at all) rather than trying to tell the parser "don't treat this as structure" — there is no channel through which to tell it that, so the only reliable defense is to make the trigger characters not present in the first place. This same bracket-stripping incidentally also closes the image/thumbnail vector — `inline()`'s image regex (src/utils/markdownToJiraWiki.ts:103) turns Markdown image syntax (an exclamation mark, then bracketed alt text, then a parenthesized URL) into a Jira `!url!` or `!url|thumbnail!` reference, and that regex requires literal `[`/`]` around the alt text, so once those are stripped a sanitized value can never reconstruct the shape needed to trigger it, even though nothing in `sanitizeCellText()` was written with images specifically in mind.

## Residual Risk (Not Yet Fixed)

A `ce-compound` security-review pass on this doc found that `sanitizeCellText()`'s stripped/replaced character set (newlines, `|`, `*_`\`[]`) is **not exhaustive** against everything `markdownToJiraWiki()` recognizes — two narrower injection vectors survive in the code as shipped:

- **Strikethrough (`~~text~~`), reachable from every sanitized field.** `inline()`'s strikethrough regex (`/~~(.+?)~~/g`, src/utils/markdownToJiraWiki.ts:118) is a mid-line transform exactly like bold/italic — but `sanitizeCellText()` never strips `~`. A CVE summary containing `~~injected~~` still renders as struck-through text in the ticket. Lower severity than the closed vectors — it produces only a styling artifact, no fabricated heading/table row and no clickable link — but it is a real, live gap the two existing tests (`src/test/waltzReport.test.ts:239-261`, `:263-279`) don't cover.
- **Line-start structural markup, reachable only from `maxVulnRating` and `nameVersion`.** Every other interpolation point places the sanitized value *after* a trusted prefix character on the same line (`**`, `- `, `| `), which keeps it out of line-start position. But `lines.push(sanitizeCellText(component.maxVulnRating))` (src/utils/waltzReport.ts:276) and `lines.push(sanitizeCellText(component.nameVersion))` (src/utils/waltzReport.ts:317) push the sanitized value as the **entire line**, with nothing in front of it — exposing it to `markdownToJiraWiki()`'s line-start-anchored rules whose trigger characters `sanitizeCellText()` never strips: the horizontal-rule check (`-{3,}`, line 34 — hyphens aren't stripped, only `*`/`_` are), the blockquote check (`line.startsWith('> ')`, line 41 — `>` isn't stripped), the unordered-list check (`[-*+]`, line 52 — `-`/`+` aren't stripped, only `*` is), and the ordered-list check (`\d+\.`, line 61 — digits/`.` are untouched). A crafted `maxVulnRating` value of `"1. URGENT - already resolved, close without review"` would render as an authoritative-looking numbered list item — a plausible low-grade social-engineering nudge against a triager skimming the ticket, though still no fabricated heading and no live link.

Neither gap is currently exploited or reported; both were caught by documentation-time review, the same way the original P1 was. They're recorded here, unfixed, so the next person who touches this code (or copies this pattern elsewhere) has an accurate picture rather than trusting the "closes the hole" framing above as unconditional.

## Prevention

When sanitizing untrusted input that will be fed through a **custom or hand-written parser/renderer** (as opposed to a well-known, spec-compliant library), do not assume standard escape semantics — backslash-escaping, HTML-entity-escaping, `\uXXXX`-escaping, etc. — apply. Those conventions only neutralize a match if the parser was specifically built to recognize and consume the escape sequence and suppress its normal rule as a result. Before writing (or trusting) any escaping helper against such a parser: read the parser's actual matching logic — every regex, every `split()`, every "does this line start with X" check — and confirm each one has an escape-consumption branch. If it doesn't, escaping is not just ineffective, it's strictly worse than doing nothing extra: the escape character becomes stray leftover content in the output in addition to the injection still succeeding. In that case, sanitize by removing or substituting the specific characters/sequences each matching rule requires to fire at all (as `sanitizeCellText()` does here — newlines, `|`, and the inline-markup trigger set), not by prefixing them.

Concretely, verify any such sanitizer with a test that constructs one crafted value containing every trigger character/sequence relevant to the target format in one string (e.g. `'Injected\n# Fake Heading\n| a | b |\n[click me](http://evil.example) *bold*'`) and asserts the *rendered output* contains none of the structural markup that value could have produced (no `h1.` heading, no extra `||...||` table row, no live `[text|url]` link, no bold/italic wrapping) — plus a second, narrower test for any single high-value trigger character used inside your own generated structure (e.g. a literal `|` inside a value that must stay one table cell), asserting the surrounding structure you control stays intact. See `src/test/waltzReport.test.ts:239-261` and `:263-279` for the concrete pattern.

The Residual Risk section above is exactly what that verification discipline missed the first time: the fix covered every vector the two existing tests happened to exercise, not literally every rule the target parser has. Two sharper practices follow from that gap:

- **Enumerate exhaustively, not representatively.** List every line-start check and every `inline()`-style regex the target parser implements — not just the ones your first crafted payload happens to trigger — and pay particular attention to any interpolation point where the untrusted value becomes an **entire line** by itself with no trusted prefix character, since that exposes it to every line-start rule at once, a strictly larger surface than a value embedded mid-line after trusted text.
- **Prefer an allowlist over a denylist where the field's legitimate values allow it.** `sanitizeCellText()` is a denylist (strip known-dangerous characters), which is exactly why the Residual Risk vectors above exist — the list wasn't exhaustive, and it will silently stop being exhaustive again if the target parser ever gains new syntax. For narrow fields like CVE ids, severities, version strings, and file paths — none of which need arbitrary Unicode/punctuation to stay useful — restricting to a known-safe character range (alphanumerics, spaces, a short punctuation allowlist) is more robust against parser evolution than enumerating what to strip.

## Related Issues

- `docs/solutions/logic-errors/redaction-substring-match-false-positives.md` — the only other existing solutions doc in this repo; unrelated (a log-redaction key-matching bug, not an injection/sanitization issue). No overlap.
- **Open risk, not yet fixed, and more directly exploitable than the vulnerability this doc covers**: the sibling Veracode Detailed Report import (`src/utils/veracodeReport.ts:160-185`, `buildDescriptionWiki()` for `VeracodeFlaw`) has the same shape of untrusted-input problem — it interpolates unsanitized, externally-sourced values (`flaw.description`, `flaw.recommendation`, `flaw.module`, `flaw.functionPrototype`) directly into hand-authored Jira wiki markup (`h3. Description\n${flaw.description}`, etc.), with no `sanitizeCellText()`-equivalent step. The Waltz path at least forces an attacker to work *through* `markdownToJiraWiki()`'s Markdown-side quirks; the Veracode path writes **literal Jira wiki markup directly**, with no conversion step at all — per this project's Jira API conventions, descriptions are sent and rendered as raw wiki-markup strings, so any Jira-native wiki syntax embedded in `flaw.description` (a fake `hN.` heading, a native `[text|url]` link, a `{quote}`/`{code}`/`{noformat}` block, a `----` rule) is interpreted with zero friction. **`sanitizeCellText()` is not a drop-in fix for this path** — it targets Markdown trigger characters because its output feeds `markdownToJiraWiki()`; Jira's own wiki markup uses an overlapping but distinct trigger set (`hN.` headings with no `#`, `[text|url]` links with no `()`, `{...}` block markers, single-character `*`/`_`/`-`/`+`/`^`/`~` inline markers, `{{monospace}}`). A future fix needs a sibling sanitizer tuned to that set, not a reused import of this one. Worth a follow-up security pass on `veracodeHandler.ts`/`veracodeReport.ts` before treating Veracode import descriptions as safe from the same class of injection.
