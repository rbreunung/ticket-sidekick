# Known-Limitation Register

A register of known limitations this codebase's maintainer has consciously
decided not to fix right now — not every deferred item, only the ones
knowingly chosen to defer. A scheduled Routine checks in roughly monthly and
walks through the Active Register with the maintainer; see
[`docs/plans/2026-09-14-0736-feat-known-limitation-register-plan.md`](plans/2026-09-14-0736-feat-known-limitation-register-plan.md)
for the full design.

## Convention

**What qualifies.** A consciously-deferred known limitation — one the
maintainer looked at and chose not to fix immediately, not every limitation
this codebase has. Most limitations should still be resolved or permanently
declined at the moment they're found; only the few genuinely kept open get
an entry here.

**Fields.** Each Active Register row carries:

- **ID** — a stable `KL<N>` identifier (next unused number; never reused;
  gaps after removal are fine), mirroring this repo's `R<N>`/`U<N>`
  convention.
- **Description / Pointer** — what the limitation is, with a repo-relative
  pointer (file:line, or a doc section) to where it's fully described.
- **Found** — the date the entry was registered.
- **Severity** — `High`, `Medium`, or `Low`.
- **Reason** — why it wasn't resolved immediately.

**How the Routine uses this file.** On each accepted monthly check-in, the
Routine reads this Convention section for the current fields and severity
scale, then reads the Active Register below. It presents every row sorted
by severity (High → Medium → Low) and lets the maintainer choose, per row:
fix it now (removed from the Active Register), leave it unchanged (stays
as-is), or declare it a permanent won't-fix (moved to the Won't-Fix Log
below, with its reason and the date declined, before removal). All of a
firing's decisions are written back together, once, after the walkthrough
ends, and the Routine commits and pushes that change to this repo's tracked
branch before the firing ends.

**Adding a new entry.** When you consciously decide to defer a limitation
rather than fix or permanently decline it, add a row to the Active Register
below with the next unused `KL<N>` ID and a severity.

## Active Register

| ID | Description / Pointer | Found | Severity | Reason |
| --- | --- | --- | --- | --- |
| KL1 | Veracode data-path trace not shown in tickets — `docs/report-import.md:55-58` | 2026-09-14 | Medium | Full data-path support needs the Findings REST API instead of the Detailed Report XML; out of scope for the importer as built. |
| KL2 | Waltz schema validated against a single real export — `docs/report-import.md:76-78` | 2026-09-14 | Medium | No second real export was available to validate against at ship time; already caused one production bug (see `docs/solutions/integration-issues/waltz-oss-report-unzip-failure-on-real-world-xlsx.md`). |
| KL3 | Waltz parse-timeout stops waiting but doesn't cancel the parse itself — `src/utils/waltzReport.ts:220-233` | 2026-09-14 | High | The real fix (a `worker_thread` that can be terminated) is a genuine chunk of work; not yet justified without evidence it has fired for a real user. |
| KL4 | No independent-producer sentinel `.xlsx` fixture — `scripts/fixtures/build-waltz-report-fixture.mjs` | 2026-09-14 | High | Needs a real anonymized export or a different toolchain's writer; acquisition effort, not code, and not yet done. |
| KL5 | `@jira` has no token/context budget cap, unlike `@bitbucket`'s `contextBudgetRatio` — `src/participant/jira/contentHandler.ts` vs. `src/participant/BitbucketParticipant.ts` | 2026-09-14 | Medium | The fix already exists on the Bitbucket side; porting it is a real but modest change not yet scheduled. |
| KL6 | Jira's own renderer re-interpreting wiki trigger sequences inside `{{monospace}}`/`{code}`/`{noformat}` macros is unverified against a live instance — `docs/plans/2026-08-14-001-fix-jira-wiki-render-safety-plan.md`, KTD3 | 2026-09-14 | Medium | Needs a real or sandbox Jira instance to test against; deferred as a one-time manual check at ship time. |
| KL7 | Denylist sanitizers (`sanitizeCellText()`/`markdownToJiraWiki()`) will silently stop being exhaustive if Jira ever gains new macro syntax — `docs/solutions/security-issues/waltz-oss-report-markdown-injection-in-jira-wiki-converter.md` | 2026-09-14 | High | No enumeration-completeness check exists; already caused one real vulnerability when the character set was under-enumerated once. |
| KL8 | `await-upload-ticket` session (`handleAwaitUploadTicketReply` in `src/participant/jira/uploadHandler.ts`) treats any reply containing a ticket-key-shaped substring as the answer to "which ticket?", even when the reply is really an unrelated new command (e.g. "show PROJ-500" while a pending upload is awaiting a ticket key) — it gets misread as naming PROJ-500 as the upload target instead of being routed as a fresh command. | 2026-09-21 | Low | Jira sessions carry no visible "you're mid-flow" indicator, so a user has no cue that their next message will be interpreted as answering a pending prompt, and no way to abandon it except an explicit cancel word typed before the new command. Fixing this needs a "does this look like a new command instead of an answer" heuristic, which isn't yet justified without evidence it fires for a real user. |

## Won't-Fix Log

Append-only. A row here is never edited or removed once written.

| ID | Description / Pointer | Found | Severity | Reason | Declined |
| --- | --- | --- | --- | --- | --- |
