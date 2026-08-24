---
title: Jira Wiki Render Safety - Plan
type: fix
date: 2026-08-14
topic: jira-wiki-render-safety
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Jira Wiki Render Safety - Plan

## Goal Capsule

- **Objective:** Guarantee that no untrusted content — from any current or future feature — can survive as live Jira-native wiki markup in a created or modified Jira ticket, by hardening `markdownToJiraWiki()`, the single converter every content-generating flow shares, while keeping the report importers' existing field-level sanitizer in place for the separate problem it solves.
- **Product authority:** This `ce-brainstorm` dialogue, extending `docs/solutions/security-issues/waltz-oss-report-markdown-injection-in-jira-wiki-converter.md`.
- **Open blockers:** None. The one open question from dialogue (whether template-based ticket creation reaches `markdownToJiraWiki()`) was resolved during this brainstorm — see Sources / Research.

---

## Product Contract

### Summary

`markdownToJiraWiki()` — the single converter every current Jira-content-generating flow in this extension calls — gets hardened to guarantee its output can never carry a live, unconverted Jira-native wiki-markup trigger, regardless of which caller invokes it or what text reaches it. This closes two live, currently-unprotected gaps (email import, comment/description content preview) and protects any future caller by construction, without removing the report importers' existing field-level sanitizer, which solves a separate problem.

### Problem Frame

The report importers (Veracode, Waltz) recently shipped a fix (`docs/solutions/security-issues/waltz-oss-report-markdown-injection-in-jira-wiki-converter.md`) for a vulnerability where untrusted external data could survive sanitization and inject live Jira-native wiki markup — most concretely, a remote-image `!url!` tag that becomes an auto-loading tracking pixel — into a generated ticket description. That fix added Jira-native trigger characters to a field-level sanitizer, `sanitizeCellText()`, that both report importers already called before building their ticket descriptions.

That fix was scoped to the two report importers. But `markdownToJiraWiki()` — the converter both importers rely on to turn Markdown into Jira wiki markup — is also called directly, with no sanitization at all, by two other features: `buildEmailJiraWiki()` in the "create ticket from email" flow, which converts an email's body straight from HTML-derived Markdown, and the manual comment/description content-preview flow, which converts LLM-generated content. The email path is the more exposed of the two — the email body is authored by whoever sends mail to the target inbox, a substantially more open attack surface than "whoever controls a security-scan report." Neither call site currently has any protection against the same vulnerability class the report importers just closed.

### Requirements

#### Render safety

- R1. `markdownToJiraWiki()` must not emit output containing a live, unconverted Jira-native wiki-markup trigger from text it did not itself intentionally convert into that trigger. This applies regardless of caller. This does not extend to characters where Markdown's and Jira's own syntax are the identical string with no transformation step between them (currently: `_text_` italic) — there is no "converted vs. raw" distinction to exploit when the input and the live output are byte-identical either way, so the existing pass-through behavior for those cases is not a gap R1 needs to close.
- R2. The fix must not alter the rendered output of Markdown constructs `markdownToJiraWiki()` already correctly converts today (headings, tables, lists, links, bold/italic/strikethrough, code spans) — email bodies and LLM-generated content rely on that conversion producing real formatting, not stripped text.
- R3. The email-import flow (`src/participant/jira/emailHandler.ts`) is fully protected across every value it interpolates outside the converter — not just the converter call itself (covered by R1), but two converter-external mutations planning found reconstruct live Jira markup from attacker-controlled email data with no protection at all: `buildEmailJiraWiki()`'s attachment-name reconstruction (`[📎 name]` → `!name|thumbnail!`), and `buildEmailCommentHeader()`'s direct interpolation of the email's From display name (`*From:* ${senderName}`) into the comment posted by `addEmailAsComment()`. Both values are attacker-controlled (anyone who emails the target inbox) and reach a live Jira sink without passing through the converter or any sanitizer. Closing both is part of this requirement, not a separate one.
- R4. Both `markdownToJiraWiki()` call sites in the content-preview flow (`src/participant/jira/contentHandler.ts`) are protected by R1 with no additional sanitization step required at those call sites. This flow is shared by every entry point that reaches it — manual "generate content" for comments/description updates, and template-based ticket creation's `descriptionSections` Q&A (`finishTicketCreation` in `src/participant/jira/createHandler.ts`, which hands its assembled text to this same flow) — so covering these two call sites covers all of them.

#### Preserve existing protection

- R5. The report importers' field-level sanitizer (`sanitizeCellText()`/`sanitizeStandaloneLine()` in `src/utils/reportImport.ts`) keeps its current stripping behavior and protection guarantee unchanged — only its character-list source moves to a shared, data-only constant per KTD4. R1's converter-level fix does not replace this layer, since it protects against a different failure mode: an untrusted value breaking out of its slot in a hand-assembled Markdown template and injecting new structure, not renderer-unsafe raw text surviving conversion.

### Key Decisions

- **Fix at the shared chokepoint, not at each call site (session-settled: user-directed — chosen over building a standalone opt-in sanitizer utility and wiring it into each caller: a converter-level fix protects every current and future caller automatically; a separate utility only protects callers that remember to invoke it, which is exactly how the email and content-preview gaps were introduced in the first place).** Governs R1, R3, R4.
- **Keep the report importers' field-level sanitizer alongside the converter fix (session-settled: user-directed — chosen over consolidating into a single mechanism: the two sanitizers solve different problems, structural template-isolation vs. renderer safety, and collapsing them would leave the template-isolation concern unaddressed).** Governs R5.
- **Fold the email-import gap into this work's scope rather than patching it separately first (session-settled: user-directed — chosen over shipping a standalone emergency email-import patch ahead of this plan: the converter-level fix closes both known gaps in one piece of work, and the email gap, while more exposed than the original report-importer bug, did not warrant an out-of-band patch ahead of this plan).**

### Acceptance Examples

- AE1. **Covers R1, R3.** Given an email whose body text, attachment filename, or sender display name contains the literal text `!http://attacker.example/tracker.gif!`, when a ticket or comment is created from that email, then the resulting content does not contain a live `!http://attacker.example/tracker.gif!` reference — regardless of which of the three interpolation points carried it.
- AE2. **Covers R1, R4.** Given LLM-generated comment content containing a Jira-native trigger sequence (e.g. `-struck-`, `{quote}...{quote}`), when the comment is posted, then none of those sequences survive as live Jira wiki markup in the posted comment.
- AE3. **Covers R2.** Given Markdown content containing a real image (`![alt](url)`), a real bulleted list, and real bold/italic text, when converted, then each renders as the equivalent, correctly-formatted Jira wiki markup exactly as it does today — no regression.
- AE4. **Covers R1, R5.** Given the Veracode/Waltz report importers (unchanged), when a flaw or component description containing crafted Markdown-and-Jira-native trigger characters is converted, then it remains fully protected exactly as after the prior fix — this work adds a second layer, it does not remove or weaken the first.
- AE5. **Covers R1, R2.** Given a single line containing both a legitimate Markdown construct and a raw injected sequence of the identical shape (e.g. `~~real~~ and -fake-`), when converted, then the legitimate construct still renders as its correct Jira wiki-markup equivalent and the injected sequence does not — the two are byte-identical after the legitimate one converts, so this is the case where the fix's own mechanism (not just its coverage) is under test.
- AE6. **Covers R1.** Given a Jira-native trigger sequence wrapped in a Markdown code span or fenced code block (e.g. `` `!http://attacker.example/t.gif!` ``), when converted, then it survives as literal, non-live text inside the equivalent Jira monospace/code construct — documenting and testing the assumption (see Dependencies / Assumptions) that Jira's renderer does not re-interpret wiki-markup triggers inside its own monospace/code macros.

### Scope Boundaries

- LLM prompt-injection as a general problem is out of scope. The content-preview flow's exposure runs through LLM-generated text; this work narrows that specific tail (a successfully-injected malicious instruction still can't produce live dangerous markup) but does not address prompt-injection defenses broadly.
- No new product capability — this is hardening of existing content-generation paths, not a new feature.

### Dependencies / Assumptions

- Assumes `markdownToJiraWiki()` can distinguish, internally, between markup it intentionally converted and raw passthrough text. Resolved by KTD2 (Planning Contract) — inferable from processing order, not a new data structure.
- Assumes Jira's own renderer does not re-interpret wiki-markup trigger sequences inside its `{{monospace}}`/`{code}`/`{noformat}` macros. Unverified against a live instance; see KTD3 and the Verification Contract's deferred manual check.
- A shared trigger-character constant is extracted per KTD4 (Planning Contract) — data only, never shared stripping behavior, since `reportImport.ts` and the converter apply it under different rules.

### Sources / Research

- `docs/solutions/security-issues/waltz-oss-report-markdown-injection-in-jira-wiki-converter.md` — the prior fix and incident doc this work extends; its "Related Issues" section already predicted a version of this gap.
- `src/utils/markdownToJiraWiki.ts` — the converter this work hardens; full read confirmed `inline()` (`:93-127`) is the single chokepoint every textual content path (headings, blockquotes, lists, table cells, and the regular-line fallback) funnels through.
- `src/participant/jira/emailHandler.ts:325-329` (`buildEmailJiraWiki`) — confirmed unsanitized converter call, plus a second, converter-external mutation (`:328`) that reconstructs a live trigger from an attachment-name value — see R3.
- `src/utils/htmlToMarkdown.ts:56-72` — confirmed the attachment-name value R3's second mutation depends on is attacker-controlled (email-derived), the same class of value `buildFileContentDisposition()` elsewhere already treats as untrusted.
- `src/participant/jira/contentHandler.ts:116,132` — confirmed unsanitized call sites.
- `src/participant/jira/createHandler.ts:209-230` (`finishTicketCreation`) — confirmed template-based ticket creation assembles its description text and hands it to `streamContentPreview()`, the same flow R4 covers; not a separate gap.
- `src/utils/reportImport.ts` — the field-level sanitizer (`sanitizeCellText`/`sanitizeStandaloneLine`) that stays in place per R5.
- `src/test/markdownToJiraWiki.test.ts` — existing test conventions (per-construct `describe` blocks, `it('...')` naming, literal `toBe` equality) the new tests follow.

---

## Planning Contract

**Product Contract preservation:** R1-R5 unchanged in ID and core intent. R1 gained a scope note excluding characters where Markdown and Jira syntax coincide (no transformation step to protect). R3 was expanded twice — first to name the attachment-name mutation point, then again to add a second, independent converter-external mutation found in the same file (`buildEmailCommentHeader()`'s sender-name interpolation). R5's "unchanged" was reworded to scope the guarantee to behavior, not file contents, since the literal wording contradicted KTD4's mandated import change. AE5 and AE6 were added during planning to close acceptance-example gaps technical research surfaced; AE1-AE4 are otherwise unchanged. KTD1-KTD4's mechanism was substantially strengthened after review: KTD1 gained the `!text!` trigger shape (the plan's own headline exploit was missing from its own neutralization list), KTD2 switched from a spoofable content-embedded placeholder design to array-indexed extraction, KTD3 switched from per-line macro-pair matching (which a cross-line split defeats, since `inline()` never sees the whole document at once) to unconditional per-character neutralization, and KTD4's shared-constant scope was clarified to the full character union.

### Key Technical Decisions

- KTD1. **Shape-aware neutralization, not blanket character-stripping — and the shape list is `-text-`/`+text+`/`^text^`/`??text??`/`!text!`.** Only actually-wrapped Jira-native trigger sequences are neutralized; a bare, unwrapped occurrence of `-`, `+`, `^`, `?`, or `!` in ordinary prose is left untouched. Blanket-stripping (mirroring `sanitizeCellText()`'s approach) would visibly mangle ordinary email/LLM prose — e.g. every bare `?` in a comment would vanish — which R2 already rules out for free-form content. **`!text!` (remote-image embed) is explicitly in this list** — it is the exact exploit named in the Problem Frame and tested by AE1, and `convertImages()`'s regex only matches bracketed `![alt](url)` syntax, never a bare `!url!`, so nothing else in the pipeline catches it. The shape-matching regex for each of these five triggers must be validated against realistic multi-occurrence prose (e.g. `-`-heavy compound words like "state-of-the-art") as part of U1's test scenarios, not just single-character bare occurrences, since a naive `-text-` pattern can match between two hyphens inside such a compound rather than only across an intentionally-wrapped span. Governs R1, R2.
- KTD2. **Placeholder-protect the converter's own legitimate strikethrough/image output using array-indexed extraction, not the content-embedded marker style bold uses.** The file already has two structurally different placeholder mechanisms: code spans fully extract content into an external array and leave only an opaque, numeric-indexed token in the string (`\x00C<idx>\x00`, no attacker-influenced text remains inline); bold instead re-embeds the captured content directly between marker tokens (`\x00B\x00$1\x00/B\x00`), so the content stays live in the string the whole time. Mirroring bold's style for image/strikethrough protection would be spoofable in principle — a crafted input containing a literal marker-shaped sequence could be misread by the restore step as already-safe content — in a way the array-indexed style cannot be, since a spoofed or out-of-range index only ever resolves to `undefined` or another already-extracted, already-safe span — never to attacker-chosen text. Use the code-span style (array-indexed extraction) for image and strikethrough protection instead. This is the only way to distinguish a legitimate `-real-` (converted from `~~real~~`) from an injected raw `-fake-` on the same line, since after conversion the two are byte-identical (AE5). Governs R1, R2.
- KTD3. **Neutralize every raw `{`/`}` in untrusted-text code paths unconditionally, not as shape-matched pairs.** `inline()` is invoked once per line, blockquote line, or table cell — never once over the fully assembled multi-line document. Jira's `{quote}`/`{color}`/`{panel}`/`{noformat}` macros are designed to span multiple lines, so an attacker could split an opening `{quote}` onto one line and its closing `{quote}` onto another (or a different table cell); no single `inline()` call would ever see both halves together, so pair-matching within one call cannot detect — and therefore cannot neutralize — a macro assembled across lines, even though Jira's renderer processes the joined output as one document and would treat the split pair as live. Unconditional per-character neutralization closes this regardless of where the two halves land, at a low prose cost (curly braces are rare in ordinary email/LLM writing, unlike `-`/`?`). Fenced code blocks and code-span content stay categorically exempt from all neutralization, unchanged from today (they already push their own hardcoded `{code}`/`{noformat}`/`{quote}` wrapper braces, never from attacker text), on the assumption that Jira's `{{monospace}}`/`{code}`/`{noformat}` macros suppress further wiki-markup interpretation of their contents. AE6 documents and tests this assumption at the converter level; it cannot prove Jira's actual server-side behavior — see Verification Contract for the recommended one-time manual check. Governs R1.
- KTD4. **Extract a shared, data-only constant enumerating the full union of both trigger-character categories** — the Markdown-defeating set (`*_`\`[]~`) and the Jira-native set (`-+^?{}!`), matching `reportImport.ts`'s current combined character class exactly — defined in `markdownToJiraWiki.ts` and imported by `reportImport.ts`. Not shared stripping *behavior*: `reportImport.ts` strips the full set unconditionally on raw pre-conversion values; the converter neutralizes only the Jira-native subset, and only conditionally (skipping its own legitimate output per KTD2). An under-scoped constant (e.g. limited to KTD1's shape-matched subset) could silently narrow `reportImport.ts`'s protection if wired in naively — the constant must be the full set so `reportImport.ts`'s existing regex is reproducible from it without omission. This repo has under-enumerated this character set twice before (see the incident doc); one source of truth closes that failure mode. `reportImport.ts` already treats the converter as the sink its sanitized output feeds, so this dependency direction matches the existing relationship rather than introducing a new one. Governs R1, R5.
- KTD5. **Close `buildEmailJiraWiki()`'s attachment-name gap with `sanitizeCellText()`, not a second converter pass.** The attachment filename becomes literal Jira image-embed syntax directly (`!name|thumbnail!`) — it never passes through Markdown at all, so it needs value-level sanitization before interpolation, the same shape of fix already applied to other email-derived filenames elsewhere in this codebase, not converter-level protection. Governs R3.
- KTD6. **Close `buildEmailCommentHeader()`'s sender-name gap with `sanitizeCellText()`**, the same fix shape as KTD5 and for the same reason: the sender display name is attacker-controlled (email `From` header) and is interpolated directly into a live Jira wiki-markup comment line (`*From:* ${senderName}`) with no protection, independently of the converter. Governs R3.

### High-Level Technical Design

`inline()` (`src/utils/markdownToJiraWiki.ts:93-127`) is the single function every textual content path in the converter funnels through. The fix extends its existing extract-placeholder-restore pattern (today used only for code spans and bold) so image and strikethrough conversion use the same **array-indexed** extraction style as code spans (KTD2) — not bold's content-embedded style — then runs the new neutralization pass over whatever text is left unprotected. Directional only — not implementation-ready code:

```text
function inline(line):
  text = line
  text, codeSpans     = extractCodeSpans(text)          // existing, unchanged — array-indexed
  text, imageSpans    = extractImages(text)             // existing regex; NEW: array-indexed extraction (mirrors codeSpans, not bold)
  text                = convertLinks(text)               // existing, unchanged
  text, boldSpans     = extractBold(text)                // existing, unchanged (content-embedded — fine here, bold has no dangerous single-character trigger to protect against)
  text                = convertItalic(text)              // existing, unchanged — see KTD/R1 note on why raw _text_ needs no protection
  text, strikeSpans   = extractStrikethrough(text)       // existing regex; NEW: array-indexed extraction (mirrors codeSpans)
  text                = neutralizeJiraTriggers(text)     // NEW: shape-match -text-/+text+/^text^/??text??/!text!;
                                                          //      unconditionally strip every remaining raw { and } (KTD3);
                                                          //      operates only on text left in the string — imageSpans/
                                                          //      strikeSpans content is already out-of-band, nothing to skip
  text                = restoreBold(text)                // existing, unchanged
  text                = restoreImages(text, imageSpans)  // NEW — array lookup, not marker-pattern regex
  text                = restoreStrikethrough(text, strikeSpans) // NEW — array lookup, not marker-pattern regex
  text                = restoreCodeSpans(text)           // existing, unchanged
  return text
```

Ordering is load-bearing: `neutralizeJiraTriggers` must run after image/strikethrough content is extracted out-of-band and before it's restored, or it would either neutralize the converter's own legitimate output or fail to neutralize raw injected sequences sitting in the same string. Using array-indexed extraction (not marker-pattern restoration) for images and strikethrough means the restore step can never be spoofed by attacker-crafted text shaped like a placeholder token — a spoofed or out-of-range index resolves to `undefined` or another already-safe span, never to attacker-chosen content, unlike a regex-matched marker pattern would.

---

## Implementation Units

### U1. Harden `inline()` with shape-aware Jira-native trigger neutralization

- **Goal:** Close R1 and R2 by extending `inline()`'s conversion pipeline per KTD1-KTD4.
- **Requirements:** R1, R2
- **Dependencies:** None
- **Files:**
  - `src/utils/markdownToJiraWiki.ts`
  - `src/test/markdownToJiraWiki.test.ts`
  - `src/utils/reportImport.ts`
  - `src/test/reportImport.test.ts`
- **Approach:**
  1. Extract the shared Jira-native trigger character constant (KTD4, full union of both categories) at the top of `markdownToJiraWiki.ts`; import it into `reportImport.ts` in place of that file's own inline character list, keeping `reportImport.ts`'s stripping behavior byte-identical to today.
  2. Switch image and strikethrough conversion to array-indexed extraction (KTD2), mirroring the existing code-span pattern rather than bold's content-embedded pattern.
  3. Add the shape-matching neutralization pass (KTD1: `-text-`/`+text+`/`^text^`/`??text??`/`!text!`, plus KTD3's unconditional `{`/`}` stripping) after strikethrough extraction and before placeholder restoration, per the Technical Design ordering.
- **Execution note:** Add the crafted-payload and shape-preservation tests first, then implement — this is security-sensitive, precisely-specifiable behavior, and the existing test file's per-construct `describe` structure makes each target behavior easy to state as a failing test up front.
- **Technical design:** See Planning Contract's High-Level Technical Design.
- **Patterns to follow:** The existing array-indexed extract-restore pattern for code spans (`:96-99`, restored `:124`).
- **Test scenarios:**
  - Raw `-struck-`, `+underline+`, `^super^`, `??cite??`, `!http://evil.example/t.gif!`-shaped sequences are neutralized, not present verbatim in output. Covers AE1 (converter-level slice).
  - A raw, unmatched single `{` or `}` in ordinary text is stripped (KTD3) — e.g. a footnote-style `{1}` loses its braces; documented as an accepted, low-cost prose trade-off, not a regression.
  - A macro pair split across two lines (e.g. `{quote}` on one line, a second `{quote}` on a later line in the same submitted content) does not survive as a live macro in the joined output — proves KTD3's unconditional-strip fix actually closes the cross-line gap pair-matching couldn't.
  - AE5: a single line containing both `~~real~~` and a same-shape raw `-fake-` sequence — the legitimate one still converts, the injected one does not survive.
  - AE6: a Jira-native trigger sequence wrapped in a code span or fenced code block survives as literal text; the test's own description documents the Jira-monospace-suppression assumption it relies on.
  - Bare, unwrapped `-`, `+`, `^`, `?`, `!` characters in ordinary prose (e.g. "co-worker", "x^2", "what?", "great!") are left unaltered. Covers AE3 (extended).
  - Multi-hyphen compound-word prose ("state-of-the-art", "well-known-issue") is left unaltered — the shape-matching regex must not match a substring between two hyphens that both belong to legitimate compound words, not just the single-hyphen case.
  - Legitimate Markdown image/strikethrough/bold/link/code-span conversion is unchanged — regression check against this file's existing test suite.
  - `reportImport.ts`'s `sanitizeCellText()`/`sanitizeStandaloneLine()` strip the identical character set after importing the shared constant as before the refactor — regression check against `src/test/reportImport.test.ts`'s existing suite.
- **Verification:** `npx vitest run src/test/markdownToJiraWiki.test.ts src/test/reportImport.test.ts` green, including the new `describe('render safety', ...)` block.

### U2. Close `emailHandler.ts`'s two converter-external gaps

- **Goal:** Finish R3 by sanitizing both attacker-controlled values `emailHandler.ts` interpolates directly into live Jira wiki markup without going through the converter: the attachment filename (KTD5) and the sender display name (KTD6).
- **Requirements:** R3
- **Dependencies:** None (uses the existing, unchanged `sanitizeCellText()` from `reportImport.ts`, per R5)
- **Files:**
  - `src/participant/jira/emailHandler.ts`
  - `src/test/emailHandler.test.ts`
- **Approach:**
  1. Import `sanitizeCellText` from `../../utils/reportImport` into `emailHandler.ts`.
  2. Wrap the captured filename group with `sanitizeCellText()` before interpolating it into the `!$1|thumbnail!` replacement in `buildEmailJiraWiki()`, per KTD5.
  3. Wrap `senderName` with `sanitizeCellText()` before interpolating it into `*From:* ${senderName}` in `buildEmailCommentHeader()`, per KTD6.
- **Test scenarios:**
  - `buildEmailJiraWiki()` with a normal inline-image placeholder (`[📎 photo.png]`) still produces `!photo.png|thumbnail!` unchanged — no regression.
  - AE1 (full end-to-end, attachment path): a crafted attachment filename containing `!`, `|`, or another Jira-native trigger character does not produce a live or malformed Jira image-embed trigger in the final output.
  - AE1 (full end-to-end, sender path): a crafted email `From` display name containing a Jira-native trigger character does not produce a live trigger in a comment posted via `addEmailAsComment()`.
  - `buildEmailCommentHeader()` with a normal sender name still produces `*From:* <name>` unchanged — no regression.
  - The unrelated `\n{3,}` → `\n\n` collapse in `buildEmailJiraWiki()` still behaves correctly alongside the filename fix.
- **Verification:** `npx vitest run src/test/emailHandler.test.ts` green.

### U3. End-to-end regression verification across all callers

- **Goal:** Confirm R4 (content-preview flow) and R5 (report importers) hold once U1 and U2 land, with tests that prove full-output behavior, not just unit-level sanitizer coverage.
- **Requirements:** R4, R5
- **Dependencies:** U1, U2
- **Files:**
  - `src/test/contentHandler.test.ts`
  - `src/test/veracodeReport.test.ts`
  - `src/test/waltzReport.test.ts`
- **Approach:**
  1. Confirm `contentHandler.ts`'s two `markdownToJiraWiki()` call sites need no code change — U1 alone should satisfy R4, since neither call site has `emailHandler.ts`'s post-conversion mutation problem.
  2. Add one integration test per call site (createTicket path, addComment/updateField path) feeding a crafted Jira-native-trigger payload through the real content-preview flow and asserting on the final posted text.
  3. Run the existing Veracode/Waltz test suites unmodified against the now-hardened converter — every currently-passing test, including the fixed-string "renders all sections" tests, must still pass byte-for-byte.
- **Test scenarios:**
  - AE2: both `contentHandler.ts` call sites correctly neutralize a crafted Jira-native payload end-to-end.
  - AE4: the full existing Veracode/Waltz test suites pass unchanged against the hardened converter.
- **Verification:** `npx vitest run` (full suite) green; `npm run compile` clean.

---

## Verification Contract

| Command | Applies to | Gate |
|---|---|---|
| `npm run compile` | All units | Must be clean — no TypeScript errors |
| `npx vitest run` | All units | Full suite green, zero regressions from the pre-change baseline |
| `npx vitest run src/test/markdownToJiraWiki.test.ts src/test/reportImport.test.ts` | U1 | New `render safety` tests pass, existing tests unchanged |
| `npx vitest run src/test/emailHandler.test.ts` | U2 | New attachment-name and sender-name tests pass, existing tests unchanged |
| `npx vitest run src/test/contentHandler.test.ts src/test/veracodeReport.test.ts src/test/waltzReport.test.ts` | U3 | New integration tests pass; existing fixed-string tests byte-identical to pre-change output |

**Deferred, non-blocking:** a one-time manual confirmation of Jira's real rendering behavior inside `{{monospace}}`/`{code}`/`{noformat}` macros against a live Jira instance (KTD3's flagged assumption). This cannot be automated from this repo and does not block merge — AE6 documents the assumption at the converter level, but the underlying Jira-server behavior should be confirmed once before the assumption is relied on long-term.

---

## Definition of Done

- `npm run compile` and the full `npx vitest run` suite are green with zero regressions.
- AE1 through AE6 each have a passing test.
- `reportImport.ts` imports the shared, full-union trigger-character constant from `markdownToJiraWiki.ts` rather than redefining its own character list, and its stripping behavior is verified unchanged (KTD4).
- Both `emailHandler.ts` gaps are closed: the attachment filename (KTD5) and the sender display name (KTD6).
- Image and strikethrough protection uses array-indexed extraction, not a content-embedded marker pattern (KTD2).
- The `{`/`}` neutralization is unconditional per-character, not pair-matched, and the cross-line macro-split test scenario (U1) passes (KTD3).
- No leftover experimental placeholder-format variants remain in the diff if more than one approach was tried during implementation.
- The Jira-monospace-suppression manual verification (see Verification Contract) is either performed or explicitly logged as an accepted follow-up, not silently skipped.
