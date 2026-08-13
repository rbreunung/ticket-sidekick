# Waltz OSS Report → Jira Tickets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user import a Waltz/SCA "OSS Report" `.xlsx` export, review the reported vulnerable open-source components (filtered by severity + remediation action), pick which ones are relevant, and bulk-create one Jira ticket per selected component — reusing the existing `@jira` participant's template/creation pipeline. This mirrors the existing Veracode Detailed Report import feature (`docs/superpowers/plans/2026-08-10-veracode-report-to-tickets.md`) almost exactly, swapping XML/`fast-xml-parser` for `.xlsx`/`read-excel-file`. No changes to `IJiraClient`/`JiraApiClient`/`MockJiraClient` are required.

**Architecture:** Mirrors the Veracode import feature exactly:

```text
VS Code command "ticket-sidekick.importWaltzReport"
  → file picker (*.xlsx)
  → src/utils/waltzReport.ts:parseWaltzReport() + filterComponents()   (pure, no vscode import)
  → build WaltzTemplateSelectionSession → workspaceState → open chat "@jira import oss report"

JiraParticipant.ts (routing)
  → new Operation 'importWaltzReport' in llmHelpers.ts (chat-only entry point mirrors "importVeracode": opens its own
    file picker if no session exists yet, so `@jira import oss report` also works without the command)
  → src/participant/jira/waltzHandler.ts
      Phase 1: template selection      (WaltzTemplateSelectionSession, marker <!-- jira:waltz-template -->)
      Phase 2: de-dup search + review  (WaltzReviewSession,           marker <!-- jira:waltz-review -->)
      Phase 3: batch creation          (loops TicketService.createTicket, mirrors executeVeracodeBatch)
                    ↓
              TicketService.createTicket / searchTicketsRaw   (existing, unmodified)
              FieldResolver.resolve                            (existing, unmodified)
              TemplateService.loadTemplates                    (existing, unmodified)
```

**Tech Stack:**
- `read-excel-file` (new runtime dependency) — reads the `.xlsx` file. Chosen over `xlsx`/SheetJS (stuck on npm at a stale 2022 version; newer releases only ship via SheetJS's own CDN, a supply-chain concern), `exceljs` (9 transitive dependencies, includes write support we don't need), and `node-xlsx` (its dependency is a tarball URL pointing at `cdn.sheetjs.com`). `read-excel-file` has only 4 small transitive dependencies, is read-only (matches our need exactly), and is actively maintained.
- `write-excel-file` (new **dev**Dependency only, never imported by runtime code) — used solely by a one-off fixture-generation script to author the committed `.xlsx` test fixtures, since fixtures must be real binary `.xlsx` files, not built in memory at test time.
- VS Code Extension API, Vitest (unit tests).

**Security notes (OWASP-conscious):**
- `.xlsx` is a ZIP container; `read-excel-file` unzips it with `unzipper-esm` (Node) and parses the inner XML with `saxen`, a minimal SAX parser with no DTD/external-entity resolution — inherently immune to classic XXE. The **nested-archive** variant of a zip bomb is not possible (`.xlsx` has a fixed, shallow internal structure with no nested zips), but a single highly-compressible worksheet entry inside a validly-shaped, size-capped file could still expand to a large in-memory payload during decompression — the 20 MB cap below bounds the *compressed* input, not the decompressed size. Mitigated with a hard parse timeout (see Task 4's `PARSE_TIMEOUT_MS`) so a pathological file fails fast instead of exhausting memory or hanging the extension host.
- Defense in depth: cap the input file size at 20 MB before handing it to `read-excel-file` (resource-exhaustion protection), mirroring the Veracode import's `MAX_REPORT_BYTES` guard.
- Component names/labels derived from spreadsheet cell contents are sanitized (`sanitizeComponentLabel()`) before ever being used as a Jira label or interpolated into JQL, the same defense-in-depth principle as the Veracode import's numeric-only `issueid` guard.
- All ticket content is Jira-wiki-escaped the same way existing content is — no raw HTML/script injection risk since Jira renders wiki markup, not HTML.

**Sample data disclosure note:** All `.xlsx` fixtures, worked examples, and dummy data in this plan use **entirely fictitious** component names, versions, and CVE identifiers (`example-lib`, `1.2.3`, `CVE-2099-0001`, etc.). The **column headers and sheet names** referenced below (`Component name and version`, `Max Vuln Rating`, `Remediation Action`, `Component Instance Path`, `CVE Id`, `CVE Summary`, `Overall Severity`, `CVSS_V3 severity base score`, `Fixed Version`, sheets `ComponentRemediations` / `VersionInstances` / `Vulnerabilities`) are structural facts — the actual column/sheet names used by this report format — carried over from inspecting one real (anonymized) export, so that the schema in this plan is realistic and reviewable. No specific finding, component, or vulnerability from that real report appears anywhere in this plan.

**Open design points already resolved with the user (do not re-litigate without checking in):**
- Severity floor and included remediation-action values are both configurable settings (`ticketSidekick.waltz.minVulnRating`, `ticketSidekick.waltz.includeRemediationActions`), mirroring the Veracode import's configurability.
- Component labels are sanitized **literal** names, prefixed `oss-dep-`, with a 6-hex-char hash of the raw `nameVersion` appended as a disambiguating suffix (amended during doc review — see Task 6's `sanitizeComponentLabel`): the label stays human-readable, but the suffix makes it collision-safe as the sole dedup key, since sanitization alone can map two distinct components (e.g. differing only in a separator character) to the identical readable text.
- `VersionInstances` / `Vulnerabilities` sheets are optional — if either is missing or empty for a component, the ticket is still created with that section omitted, rather than failing the whole import.
- CVE list in the ticket description is capped at the top 10 by severity/CVSS (with a "+N more" note); affected-artifact paths are **not** capped.
- The description leads with a dedicated **"Most Critical Vulnerability"** section (`CVE Id` + `CVE Summary`, from the `Vulnerabilities` sheet) for the single highest-severity/CVSS finding, ahead of the full artifact and CVE lists — this is what makes clear, at a glance, what the ticket is actually for. The Review-screen **toggle mechanism is identical to the Veracode import**: `ok` / `c`|`cancel` / a space-or-comma-separated list of row ids to flip inclusion, same parser shape as `parseVeracodeReviewInput`/`applyVeracodeToggle`.
- Ticket **summary/title** format is `[OSS] <name:version> — <Max Vuln Rating>` (e.g. `[OSS] example-lib:1.2.3 — Critical`) — no embedded CVE count, kept short to avoid Jira summary truncation.
- The description is authored as **Markdown** internally (headings, bullet list, and a real pipe table for "Known vulnerabilities") and converted to Jira wiki markup via the existing `markdownToJiraWiki()` converter (`src/utils/markdownToJiraWiki.ts`) — no hand-authored Jira table syntax needed. The "Known vulnerabilities" section renders as an actual table (`CVE` / `Severity` / `CVSS` / `Fixed Version` columns) instead of a bullet list.
- This Waltz plan's own batch completion messages (`executeWaltzBatch`, Task 9) link each created ticket id to Jira (`[KEY](baseUrl/browse/KEY)`, falling back to a plain key when no base URL is configured), matching the convention already used elsewhere (`TicketService.formatIssueLinkLine`, the "Already ticketed" column). This is new-feature design only — nothing outside `waltzHandler.ts` is touched by it.

**Open points — not yet resolved, for a future plan iteration (no real source code has been changed for these):**
- **Ticket-id linking is not yet retrofitted to existing shipped flows.** Today, `executeVeracodeBatch` (`src/participant/jira/veracodeHandler.ts`) prints a bare key (`` ✓ ${key ?? '?'} — ${row.summary} ``), and the single-ticket creation confirmation used by both `createHandler.ts` (`finishTicketCreation`) and `emailHandler.ts` (`finishEmailTicket`) streams `TicketService.createTicket`'s return value verbatim — `` Created ${key}: **${summary}** (...) `` — which also has no link, since `createTicket()` doesn't receive a `baseUrl`. Retrofitting all of these to link the ticket id (consistent with `formatIssueLinkLine`'s existing convention) should be scoped as its own small follow-up plan/task, touching `TicketService.createTicket` (thread an optional `baseUrl`) and the two call sites above, plus `veracodeHandler.ts`'s `executeVeracodeBatch` — rather than folded into this Waltz feature or done ad hoc.
- **The shipped Veracode import writes Jira wiki markup directly, not Markdown.** Confirmed by inspection: `buildDescriptionWiki()` in `src/utils/veracodeReport.ts` hand-authors Jira wiki syntax (`h3.` headings, `*bold*`, bullet lines) directly, unlike this Waltz plan's `buildDescriptionWiki()` (`src/utils/waltzReport.ts`), which authors plain Markdown and converts it once via `markdownToJiraWiki()`. For consistency — and so the Veracode description gets the same benefits (an easy path to a real table instead of bullets, less risk of hand-written wiki-markup mistakes) — the Veracode implementation should probably be refactored to the same Markdown-then-convert approach. Left as an open point rather than implemented now; should be scoped as its own small follow-up plan/task rather than folded into this Waltz feature.

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `package.json` | MODIFY | Add `read-excel-file` dependency + `write-excel-file` devDependency; add `ticket-sidekick.importWaltzReport` command; add `ticketSidekick.waltz.*` settings |
| `scripts/fixtures/build-waltz-report-fixture.mjs` | CREATE | One-off Node script (uses `write-excel-file`) that authors the committed `.xlsx` fixtures |
| `src/test/fixtures/waltz/sample-report.xlsx` | CREATE | Synthetic multi-component fixture covering the filter/degradation edge cases |
| `src/test/fixtures/waltz/malformed-report.xlsx` | CREATE | Truncated/invalid `.xlsx` bytes, for error-path tests |
| `src/test/fixtures/waltz/missing-required-sheet-report.xlsx` | CREATE | Valid `.xlsx` lacking the `ComponentRemediations` sheet, for the "missing sheet" error test |
| `src/utils/waltzReport.ts` | CREATE | Pure domain logic: `.xlsx` parsing, filtering, summary/description/label builders, dedup helpers |
| `src/test/waltzReport.test.ts` | CREATE | Unit tests (TDD) for all pure functions in `waltzReport.ts` |
| `src/participant/sessionState.ts` | MODIFY | Add `WaltzTemplateSelectionSession`, `WaltzReviewSession` types (re-exports `WaltzReviewRow`, which is defined in `waltzReport.ts` to avoid a circular import — see Task 7); add `buildWaltzReviewTable`, `parseWaltzReviewInput`, `applyWaltzToggle` pure helpers |
| `src/test/JiraParticipant.test.ts` | MODIFY | Add tests for the new pure `sessionState.ts` helpers (table building, toggle parsing) |
| `src/participant/jira/waltzHandler.ts` | CREATE | Chat glue: file picker (chat-only entry), template selection, dedup search + review screen, batch creation |
| `src/participant/jira/llmHelpers.ts` | MODIFY | Add `'importWaltzReport'` to `Operation` union + `INTENT_PROMPT` trigger phrases |
| `src/participant/JiraParticipant.ts` | MODIFY | Import + route `importWaltzReport`; add session-detection blocks for the two new markers |
| `src/extension.ts` | MODIFY | Register `ticket-sidekick.importWaltzReport` command (file picker → parse → filter → session → open chat) |
| `README.md` | MODIFY | New "OSS report import" section |
| `CLAUDE.md` | MODIFY | Key files table, settings table, session-state table entries |

---

## Task 1: Add `read-excel-file` + `write-excel-file` dependencies

**Files:**
- Modify: `package.json` (dependencies added by npm)

- [ ] **Step 1: Install the runtime dependency**

```bash
npm install read-excel-file
```

Expected: `read-excel-file` appears in `package.json` `dependencies` (ships its own TypeScript types — no `@types/*` package needed).

- [ ] **Step 2: Install the dev-only dependency**

```bash
npm install --save-dev write-excel-file
```

Expected: `write-excel-file` appears in `package.json` `devDependencies` only. It must never be imported from anything under `src/` — it exists purely to author committed test fixtures.

- [ ] **Step 3: Double-check the installed `read-excel-file` API**

Open `node_modules/read-excel-file/node/index.d.ts` and confirm the `readSheet()` overloads. As of the version researched for this plan (9.3.10), reading a **named sheet** and reading **with a schema** are two separate overloads that cannot be combined in one call — there is no single `readSheet(input, { sheet, schema })` form. The correct pattern (also the one used throughout this plan) is the two-step form shown in the package's README:

```ts
import { readSheet, parseSheetData } from 'read-excel-file/node';

const sheetData = await readSheet(buffer, 'ComponentRemediations'); // raw rows, no schema
const { objects, errors } = parseSheetData(sheetData, componentRemediationsSchema);
```

If a future version of the package *does* add a combined form, prefer it — but verify against the installed `.d.ts` first rather than assuming.

- [ ] **Step 4: Verify compile is still clean**

```bash
npm run compile
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add read-excel-file dependency + write-excel-file dev dependency for OSS report import"
```

---

## Task 2: Settings + command scaffolding in `package.json`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the command entry**

In the `contributes.commands` array, alongside `ticket-sidekick.importVeracodeReport`:

```json
{
  "command": "ticket-sidekick.importWaltzReport",
  "title": "Ticket Sidekick: Create Jira tickets from OSS report (.xlsx)"
}
```

- [ ] **Step 2: Add a new "waltz" configuration section**

In `contributes.configuration`, add a new section alongside the existing `"veracode"` one:

```json
{
  "id": "waltz",
  "title": "Ticket Sidekick — OSS Report",
  "properties": {
    "ticketSidekick.waltz.minVulnRating": {
      "type": "string",
      "enum": ["Low", "Medium", "High", "Critical"],
      "default": "High",
      "description": "Minimum 'Max Vuln Rating' to include when importing an OSS report. Components rated below this are filtered out by default (still visible in the raw file)."
    },
    "ticketSidekick.waltz.includeRemediationActions": {
      "type": "array",
      "items": { "type": "string" },
      "default": ["", "Remediate"],
      "description": "Remediation Action values to include when importing an OSS report (empty string means the column was blank). Components with any other action (e.g. 'Risk capture') are excluded by default."
    }
  }
}
```

- [ ] **Step 3: Verify JSON is valid and compile is clean**

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" && npm run compile
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "feat: add OSS report import command + settings scaffolding"
```

---

## Task 3: Fixture generation script + committed `.xlsx` fixtures

**Files:**
- Create: `scripts/fixtures/build-waltz-report-fixture.mjs`
- Create: `src/test/fixtures/waltz/sample-report.xlsx` (generated, then committed as binary)
- Create: `src/test/fixtures/waltz/malformed-report.xlsx` (generated, then committed as binary)
- Create: `src/test/fixtures/waltz/missing-required-sheet-report.xlsx` (generated, then committed as binary)

The real report has 3 sheets: `ComponentRemediations` (one row per component, the required sheet), `VersionInstances` (one row per affected artifact path per component), and `Vulnerabilities` (one row per CVE per component). All three are joined by the `Component name and version` column. This plan's fixture covers 5 fictitious components:

| # | Component name and version | Max Vuln Rating | Remediation Action | Notes |
|---|---|---|---|---|
| 1 | `example-lib:1.2.3` | Critical | _(blank)_ | Included by default settings |
| 2 | `example-io:4.5.0` | High | Remediate | Included by default settings |
| 3 | `example-json:2.0.1` | Critical | Risk capture | Excluded by default (tests `includeRemediationActions` configurability) |
| 4 | `example-cache:0.9.4` | Medium | Remediate | Excluded by default (tests `minVulnRating` floor regardless of action) |
| 5 | `example-http:3.3.3` | High | _(blank)_ | Has **zero** rows in `VersionInstances`/`Vulnerabilities` (tests graceful degradation) |

- [ ] **Step 1: Write `scripts/fixtures/build-waltz-report-fixture.mjs`**

```js
// One-off script — regenerate the committed .xlsx fixtures whenever their shape needs to change.
// Run with: node scripts/fixtures/build-waltz-report-fixture.mjs
import writeExcelFile from 'write-excel-file/node';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/test/fixtures/waltz');

const componentRemediationsData = [
  ['Component name and version', 'Max Vuln Rating', 'Remediation Action'],
  ['example-lib:1.2.3', 'Critical', null],
  ['example-io:4.5.0', 'High', 'Remediate'],
  ['example-json:2.0.1', 'Critical', 'Risk capture'],
  ['example-cache:0.9.4', 'Medium', 'Remediate'],
  ['example-http:3.3.3', 'High', null],
];

const versionInstancesData = [
  ['Component name and version', 'Component Instance Path'],
  ['example-lib:1.2.3', '/app/services/checkout/package-lock.json'],
  ['example-io:4.5.0', '/app/services/checkout/package-lock.json'],
  ['example-io:4.5.0', '/app/services/reporting/package-lock.json'],
  ['example-json:2.0.1', '/app/services/reporting/package-lock.json'],
  ['example-cache:0.9.4', '/app/services/checkout/package-lock.json'],
  // example-http:3.3.3 intentionally has NO rows here.
];

const vulnerabilitiesData = [
  ['Component name and version', 'CVE Id', 'Overall Severity', 'CVSS_V3 severity base score', 'Fixed Version', 'CVE Summary'],
  ['example-lib:1.2.3', 'CVE-2099-0001', 'Critical', 9.8, '1.2.4', 'Improper input validation may allow remote code execution via crafted deserialization payloads.'],
  ['example-lib:1.2.3', 'CVE-2099-0002', 'High', 7.5, '1.2.4', 'Insecure default configuration exposes an internal debug endpoint.'],
  ['example-io:4.5.0', 'CVE-2099-0003', 'High', 8.1, '4.5.1', 'Path traversal vulnerability allows reading arbitrary files outside the intended directory.'],
  ['example-json:2.0.1', 'CVE-2099-0004', 'Critical', 9.1, '2.1.0', 'Denial of service via unbounded recursive parsing of nested JSON structures.'],
  ['example-cache:0.9.4', 'CVE-2099-0005', 'Medium', 5.3, '1.0.0', 'Weak default cache key generation may allow cache poisoning.'],
  // example-http:3.3.3 intentionally has NO rows here.
];

await writeExcelFile([
  { data: componentRemediationsData, sheet: 'ComponentRemediations' },
  { data: versionInstancesData, sheet: 'VersionInstances' },
  { data: vulnerabilitiesData, sheet: 'Vulnerabilities' },
]).toFile(path.join(outDir, 'sample-report.xlsx'));

// Missing-required-sheet fixture: only the two optional sheets, no ComponentRemediations.
await writeExcelFile([
  { data: versionInstancesData, sheet: 'VersionInstances' },
  { data: vulnerabilitiesData, sheet: 'Vulnerabilities' },
]).toFile(path.join(outDir, 'missing-required-sheet-report.xlsx'));

console.log('Wrote sample-report.xlsx and missing-required-sheet-report.xlsx to', outDir);
```

- [ ] **Step 2: Run the script and commit the generated `.xlsx` files as binaries**

```bash
node scripts/fixtures/build-waltz-report-fixture.mjs
```

- [ ] **Step 3: Create `src/test/fixtures/waltz/malformed-report.xlsx`**

This one can't be produced by `write-excel-file` (it always writes valid files) — create it by truncating a valid one:

```bash
node -e "
const fs = require('fs');
const buf = fs.readFileSync('src/test/fixtures/waltz/sample-report.xlsx');
fs.writeFileSync('src/test/fixtures/waltz/malformed-report.xlsx', buf.subarray(0, Math.floor(buf.length / 3)));
"
```

Expected: a truncated file that is no longer a valid ZIP, so `read-excel-file` throws `InvalidInputError` with code `INVALID_ZIP` (or similar) when read.

- [ ] **Step 4: Commit the fixtures**

```bash
git add scripts/fixtures/build-waltz-report-fixture.mjs src/test/fixtures/waltz/
git commit -m "test: add Waltz OSS report .xlsx fixtures + generation script"
```

---

## Task 4: `.xlsx` parsing (TDD, pure — no `vscode` import)

**Files:**
- Create: `src/test/waltzReport.test.ts`
- Create: `src/utils/waltzReport.ts`

- [ ] **Step 1: Write the failing test file `src/test/waltzReport.test.ts` (parsing section)**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseWaltzReport, assertSafeWaltzReportSize } from '../utils/waltzReport';

const fixturePath = (name: string) => join(__dirname, 'fixtures', 'waltz', name);
const fixtureBuffer = (name: string) => readFileSync(fixturePath(name));

describe('parseWaltzReport', () => {
  it('parses all 5 components with their remediation, instance, and vulnerability data joined together', async () => {
    const components = await parseWaltzReport(fixtureBuffer('sample-report.xlsx'));
    expect(components).toHaveLength(5);

    const exampleLib = components.find(c => c.nameVersion === 'example-lib:1.2.3')!;
    expect(exampleLib.maxVulnRating).toBe('Critical');
    expect(exampleLib.remediationAction).toBeNull();
    expect(exampleLib.instancePaths).toEqual(['/app/services/checkout/package-lock.json']);
    expect(exampleLib.vulnerabilities).toHaveLength(2);
    expect(exampleLib.vulnerabilities.map(v => v.cveId).sort()).toEqual(['CVE-2099-0001', 'CVE-2099-0002']);

    const cve1 = exampleLib.vulnerabilities.find(v => v.cveId === 'CVE-2099-0001')!;
    expect(cve1.overallSeverity).toBe('Critical');
    expect(cve1.cvssV3Score).toBe(9.8);
    expect(cve1.fixedVersion).toBe('1.2.4');
    expect(cve1.cveSummary).toBe('Improper input validation may allow remote code execution via crafted deserialization payloads.');
  });

  it('joins one component to multiple instance paths across services', async () => {
    const components = await parseWaltzReport(fixtureBuffer('sample-report.xlsx'));
    const exampleIo = components.find(c => c.nameVersion === 'example-io:4.5.0')!;
    expect(exampleIo.instancePaths.sort()).toEqual([
      '/app/services/checkout/package-lock.json',
      '/app/services/reporting/package-lock.json',
    ]);
  });

  it('degrades gracefully when a component has no rows in VersionInstances/Vulnerabilities', async () => {
    const components = await parseWaltzReport(fixtureBuffer('sample-report.xlsx'));
    const exampleHttp = components.find(c => c.nameVersion === 'example-http:3.3.3')!;
    expect(exampleHttp.instancePaths).toEqual([]);
    expect(exampleHttp.vulnerabilities).toEqual([]);
  });

  it('throws a clear error on a malformed / corrupted .xlsx file', async () => {
    await expect(parseWaltzReport(fixtureBuffer('malformed-report.xlsx'))).rejects.toThrow(/could not read|invalid/i);
  });

  it('throws a clear error when the required ComponentRemediations sheet is missing', async () => {
    await expect(parseWaltzReport(fixtureBuffer('missing-required-sheet-report.xlsx')))
      .rejects.toThrow(/ComponentRemediations/);
  });
});

describe('assertSafeWaltzReportSize', () => {
  it('rejects a buffer over the 20 MB size cap', () => {
    expect(() => assertSafeWaltzReportSize(Buffer.alloc(21 * 1024 * 1024))).toThrow(/size limit/i);
  });

  it('accepts a normal, small file', () => {
    expect(() => assertSafeWaltzReportSize(fixtureBuffer('sample-report.xlsx'))).not.toThrow();
  });
});
```

- [ ] **Step 2: Implement `src/utils/waltzReport.ts` (parsing section) until the tests pass**

```ts
import { readSheet, parseSheetData, SheetNotFoundError } from 'read-excel-file/node';

export interface WaltzVulnerability {
  cveId: string;
  cveSummary: string | null;
  overallSeverity: string | null;
  cvssV3Score: number | null;
  fixedVersion: string | null;
}

export interface WaltzComponent {
  nameVersion: string;
  maxVulnRating: string;
  remediationAction: string | null;
  instancePaths: string[];
  vulnerabilities: WaltzVulnerability[];
}

const MAX_REPORT_BYTES = 20 * 1024 * 1024; // 20 MB
const REQUIRED_SHEET = 'ComponentRemediations';

export function assertSafeWaltzReportSize(buffer: Buffer): void {
  if (buffer.length > MAX_REPORT_BYTES) {
    throw new Error(`OSS report exceeds the ${MAX_REPORT_BYTES / (1024 * 1024)} MB size limit.`);
  }
}

const componentRemediationsSchema = {
  nameVersion: { column: 'Component name and version', type: String, required: true },
  maxVulnRating: { column: 'Max Vuln Rating', type: String, required: true },
  remediationAction: { column: 'Remediation Action', type: String, required: false },
};

const versionInstancesSchema = {
  nameVersion: { column: 'Component name and version', type: String, required: true },
  instancePath: { column: 'Component Instance Path', type: String, required: false },
};

const vulnerabilitiesSchema = {
  nameVersion: { column: 'Component name and version', type: String, required: true },
  cveId: { column: 'CVE Id', type: String, required: true },
  cveSummary: { column: 'CVE Summary', type: String, required: false },
  overallSeverity: { column: 'Overall Severity', type: String, required: false },
  cvssV3Score: { column: 'CVSS_V3 severity base score', type: Number, required: false },
  fixedVersion: { column: 'Fixed Version', type: String, required: false },
};

// Reads one sheet by name and parses it against a schema — read-excel-file's readSheet() can't
// combine `sheet` + `schema` in a single call (verified against the installed .d.ts in Task 1),
// so this is a deliberate two-step helper, not an oversight.
async function readNamedSheet<T extends object>(
  buffer: Buffer,
  sheetName: string,
  schema: Record<string, unknown>,
): Promise<T[]> {
  const sheetData = await readSheet(buffer, sheetName);
  const { objects, errors } = parseSheetData<T>(sheetData, schema as never);
  if (errors) {
    throw new Error(
      `OSS report sheet "${sheetName}" has invalid rows: ` +
        errors.map(e => `row ${e.row} column "${e.column}": ${e.error}`).join('; '),
    );
  }
  return objects ?? [];
}

// Optional sheets degrade to an empty array instead of failing the whole import.
async function readOptionalNamedSheet<T extends object>(
  buffer: Buffer,
  sheetName: string,
  schema: Record<string, unknown>,
): Promise<T[]> {
  try {
    return await readNamedSheet<T>(buffer, sheetName, schema);
  } catch (err) {
    if (err instanceof SheetNotFoundError) return [];
    throw err;
  }
}

const PARSE_TIMEOUT_MS = 15_000; // hard ceiling so a pathological file (e.g. a decompression-bomb-style
// worksheet entry — see "Security notes" above) fails fast instead of exhausting memory or hanging
// the extension host. Bounds wall-clock time, not memory directly, but a hung/thrashing parse is
// exactly what this catches.

export async function parseWaltzReport(buffer: Buffer): Promise<WaltzComponent[]> {
  return Promise.race([
    parseWaltzReportInner(buffer),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`OSS report parsing exceeded ${PARSE_TIMEOUT_MS / 1000}s — the file may be malformed or unusually large.`)),
        PARSE_TIMEOUT_MS,
      ),
    ),
  ]);
}

async function parseWaltzReportInner(buffer: Buffer): Promise<WaltzComponent[]> {
  assertSafeWaltzReportSize(buffer);

  let remediations: Array<{ nameVersion: string; maxVulnRating: string; remediationAction: string | null }>;
  try {
    remediations = await readNamedSheet(buffer, REQUIRED_SHEET, componentRemediationsSchema);
  } catch (err) {
    if (err instanceof SheetNotFoundError) {
      // read-excel-file's SheetNotFoundError type only declares `sheet` (singular) publicly —
      // `sheets` is set at runtime but not part of the .d.ts surface, so reference `err.message`
      // (which already embeds the available sheet list) rather than `err.sheets`.
      throw new Error(`OSS report is missing the required "${REQUIRED_SHEET}" sheet. (${err.message})`);
    }
    throw new Error(`Could not read OSS report: ${err instanceof Error ? err.message : String(err)}`);
  }

  const instances = await readOptionalNamedSheet<{ nameVersion: string; instancePath: string | null }>(
    buffer, 'VersionInstances', versionInstancesSchema,
  );
  const vulnerabilities = await readOptionalNamedSheet<{
    nameVersion: string; cveId: string; cveSummary: string | null;
    overallSeverity: string | null; cvssV3Score: number | null; fixedVersion: string | null;
  }>(buffer, 'Vulnerabilities', vulnerabilitiesSchema);

  return remediations.map(r => ({
    nameVersion: r.nameVersion,
    maxVulnRating: r.maxVulnRating,
    remediationAction: r.remediationAction,
    instancePaths: instances
      .filter(i => i.nameVersion === r.nameVersion && i.instancePath)
      .map(i => i.instancePath as string),
    vulnerabilities: vulnerabilities
      .filter(v => v.nameVersion === r.nameVersion)
      .map(v => ({
        cveId: v.cveId,
        cveSummary: v.cveSummary,
        overallSeverity: v.overallSeverity,
        cvssV3Score: v.cvssV3Score,
        fixedVersion: v.fixedVersion,
      })),
  }));
}
```

- [ ] **Step 3: Run tests**

```bash
npm test -- waltzReport
```

Expected: all parsing tests pass. (`PARSE_TIMEOUT_MS`'s fail-fast path is intentionally not covered by a deterministic unit test — faking a hang reliably through `Promise.race` + fake timers is disproportionate for a 15s ceiling that exists purely as a backstop; verify manually if the value is ever changed.)

- [ ] **Step 4: Commit**

```bash
git add src/utils/waltzReport.ts src/test/waltzReport.test.ts
git commit -m "feat: parse Waltz OSS report .xlsx into WaltzComponent[]"
```

---

## Task 5: Severity/remediation-action filtering (TDD)

**Files:**
- Modify: `src/test/waltzReport.test.ts`
- Modify: `src/utils/waltzReport.ts`

- [ ] **Step 1: Add failing tests**

```ts
import { filterComponents } from '../utils/waltzReport';

describe('filterComponents', () => {
  it('applies both the vuln-rating floor and the remediation-action allow-list (defaults)', async () => {
    const components = await parseWaltzReport(fixtureBuffer('sample-report.xlsx'));
    const filtered = filterComponents(components, { minVulnRating: 'High', includeRemediationActions: ['', 'Remediate'] });
    // example-lib (Critical, blank) and example-io (High, Remediate) and example-http (High, blank) pass;
    // example-json (Critical, "Risk capture") is excluded by action; example-cache (Medium) is excluded by rating.
    expect(filtered.map(c => c.nameVersion).sort()).toEqual([
      'example-http:3.3.3', 'example-io:4.5.0', 'example-lib:1.2.3',
    ]);
  });

  it('excludes everything below the configured rating floor even if the action matches', async () => {
    const components = await parseWaltzReport(fixtureBuffer('sample-report.xlsx'));
    const filtered = filterComponents(components, { minVulnRating: 'Critical', includeRemediationActions: ['', 'Remediate'] });
    expect(filtered.map(c => c.nameVersion).sort()).toEqual(['example-lib:1.2.3']);
  });

  it('treats a null/blank Remediation Action as the empty string for allow-list matching', async () => {
    const components = await parseWaltzReport(fixtureBuffer('sample-report.xlsx'));
    const filtered = filterComponents(components, { minVulnRating: 'Low', includeRemediationActions: [''] });
    expect(filtered.map(c => c.nameVersion).sort()).toEqual(['example-http:3.3.3', 'example-lib:1.2.3']);
  });

  it('rating comparison is case-insensitive', async () => {
    const components = await parseWaltzReport(fixtureBuffer('sample-report.xlsx'));
    const filtered = filterComponents(
      components.map(c => ({ ...c, maxVulnRating: c.maxVulnRating.toUpperCase() })),
      { minVulnRating: 'high', includeRemediationActions: ['', 'Remediate'] },
    );
    expect(filtered.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Implement in `src/utils/waltzReport.ts`**

```ts
export interface WaltzFilterOptions {
  minVulnRating: string; // 'Low' | 'Medium' | 'High' | 'Critical'
  includeRemediationActions: string[]; // '' represents a blank cell
}

const VULN_RATING_ORDER = ['None', 'Low', 'Medium', 'High', 'Critical'];

function vulnRatingRank(rating: string): number {
  const idx = VULN_RATING_ORDER.findIndex(r => r.toLowerCase() === rating.toLowerCase());
  return idx === -1 ? 0 : idx;
}

export function filterComponents(components: WaltzComponent[], options: WaltzFilterOptions): WaltzComponent[] {
  const floor = vulnRatingRank(options.minVulnRating);
  const allowedActions = new Set(options.includeRemediationActions.map(a => a.trim()));
  return components.filter(c => {
    if (vulnRatingRank(c.maxVulnRating) < floor) return false;
    const action = (c.remediationAction ?? '').trim();
    return allowedActions.has(action);
  });
}
```

- [ ] **Step 3: Run tests, then commit**

```bash
npm test -- waltzReport
git add src/utils/waltzReport.ts src/test/waltzReport.test.ts
git commit -m "feat: filter Waltz OSS components by min vuln rating + remediation action"
```

---

## Task 6: Ticket-content builders (TDD)

**Files:**
- Modify: `src/test/waltzReport.test.ts`
- Modify: `src/utils/waltzReport.ts`

Builds the ticket **summary** (one line), **description** (Jira wiki markup, mirroring `buildDescriptionWiki()`'s `h3.`-section style from the Veracode import), and the **label list**.

- [ ] **Step 1: Add failing tests**

```ts
import { buildSummary, buildDescriptionWiki, buildLabels, sanitizeComponentLabel } from '../utils/waltzReport';

describe('sanitizeComponentLabel', () => {
  it('lowercases, replaces separators with hyphens, prefixes oss-dep-, and appends a disambiguating hash', () => {
    const label = sanitizeComponentLabel('Example.Lib:1.2.3');
    expect(label).toMatch(/^oss-dep-example-lib-1-2-3-[0-9a-f]{6}$/);
  });

  it('gives two components that sanitize to the same readable text different labels via the hash suffix', () => {
    // Maven-style coordinates: an underscore and a hyphen both collapse to "-" once sanitized, so
    // the readable portion alone would collide for two genuinely different components.
    const a = sanitizeComponentLabel('org.example:my_lib:1.2.3');
    const b = sanitizeComponentLabel('org.example:my-lib:1.2.3');
    expect(a).not.toBe(b);
  });

  it('caps the label length as a safety margin against Jira label limits, without truncating the hash suffix', () => {
    const long = 'a'.repeat(300) + ':1.0.0';
    const label = sanitizeComponentLabel(long);
    expect(label.length).toBeLessThanOrEqual(250);
    expect(label).toMatch(/-[0-9a-f]{6}$/);
  });
});

describe('buildSummary', () => {
  it('formats [OSS] name:version — rating', async () => {
    const components = await parseWaltzReport(fixtureBuffer('sample-report.xlsx'));
    const exampleLib = components.find(c => c.nameVersion === 'example-lib:1.2.3')!;
    expect(buildSummary(exampleLib)).toBe('[OSS] example-lib:1.2.3 — Critical');
  });
});

describe('buildLabels', () => {
  it('always includes oss-dependency + the sanitized component label', async () => {
    const components = await parseWaltzReport(fixtureBuffer('sample-report.xlsx'));
    const exampleLib = components.find(c => c.nameVersion === 'example-lib:1.2.3')!;
    expect(buildLabels(exampleLib)).toEqual(['oss-dependency', sanitizeComponentLabel(exampleLib.nameVersion)]);
  });

  it('merges in template labels without duplicates', async () => {
    const components = await parseWaltzReport(fixtureBuffer('sample-report.xlsx'));
    const exampleLib = components.find(c => c.nameVersion === 'example-lib:1.2.3')!;
    expect(buildLabels(exampleLib, ['oss-dependency', 'team-payments'])).toEqual([
      'oss-dependency', sanitizeComponentLabel(exampleLib.nameVersion), 'team-payments',
    ]);
  });
});

describe('buildDescriptionWiki', () => {
  it('includes rating, the most critical vulnerability, affected artifacts, and a Known vulnerabilities table sorted by severity/CVSS', async () => {
    const components = await parseWaltzReport(fixtureBuffer('sample-report.xlsx'));
    const exampleLib = components.find(c => c.nameVersion === 'example-lib:1.2.3')!;
    const wiki = buildDescriptionWiki(exampleLib);
    expect(wiki).toContain('h3. Max Vuln Rating');
    expect(wiki).toContain('Critical');
    expect(wiki).toContain('h3. Most Critical Vulnerability');
    expect(wiki).toContain('*CVE-2099-0001* — Improper input validation may allow remote code execution via crafted deserialization payloads.');
    expect(wiki).toContain('h3. Affected artifacts (1 total)');
    expect(wiki).toContain('/app/services/checkout/package-lock.json');
    expect(wiki).toContain('h3. Known vulnerabilities (2 total');
    // Known vulnerabilities renders as a real Jira wiki table (built from a Markdown table via markdownToJiraWiki()).
    expect(wiki).toContain('||CVE||Severity||CVSS||Fixed Version||');
    expect(wiki).toContain('|CVE-2099-0001|Critical|9.8|1.2.4|');
    expect(wiki).toContain('|CVE-2099-0002|High|7.5|1.2.4|');
    expect(wiki.indexOf('CVE-2099-0001')).toBeLessThan(wiki.indexOf('CVE-2099-0002')); // higher CVSS first
    // the highlighted "most critical" mention must come before the full known-vulnerabilities table
    expect(wiki.indexOf('h3. Most Critical Vulnerability')).toBeLessThan(wiki.indexOf('h3. Known vulnerabilities'));
  });

  it('omits the artifacts/CVE sections gracefully when a component has none', async () => {
    const components = await parseWaltzReport(fixtureBuffer('sample-report.xlsx'));
    const exampleHttp = components.find(c => c.nameVersion === 'example-http:3.3.3')!;
    const wiki = buildDescriptionWiki(exampleHttp);
    expect(wiki).toContain('h3. Most Critical Vulnerability');
    expect(wiki).toContain('No CVE-level detail was reported for this component.');
    expect(wiki).toContain('No affected artifact paths were reported');
  });

  it('falls back to a placeholder when the top vulnerability has no CVE Summary cell', () => {
    const noSummary: WaltzComponent = {
      nameVersion: 'example-nosum:1.0.0',
      maxVulnRating: 'High',
      remediationAction: null,
      instancePaths: [],
      vulnerabilities: [{ cveId: 'CVE-2099-0099', cveSummary: null, overallSeverity: 'High', cvssV3Score: 7.2, fixedVersion: null }],
    };
    const wiki = buildDescriptionWiki(noSummary);
    expect(wiki).toContain('*CVE-2099-0099* — No summary reported.');
  });

  it('caps the shown CVE table at 10 rows and adds a "+N more" note', () => {
    const many: WaltzComponent = {
      nameVersion: 'example-many:9.9.9',
      maxVulnRating: 'Critical',
      remediationAction: null,
      instancePaths: [],
      vulnerabilities: Array.from({ length: 14 }, (_, i) => ({
        cveId: `CVE-2099-${String(i).padStart(4, '0')}`,
        cveSummary: `Fictitious summary for issue ${i}.`,
        overallSeverity: 'High',
        cvssV3Score: 7,
        fixedVersion: null,
      })),
    };
    const wiki = buildDescriptionWiki(many);
    expect(wiki).toContain('(14 total — showing top 10)');
    expect(wiki).toContain('+4 more not shown');
    expect(wiki).toContain('*CVE-2099-0000* — Fictitious summary for issue 0.'); // lowest cveId wins tie-break, is "most critical"
    expect(wiki).toContain('|CVE-2099-0000|High|7|n/a|'); // same row also appears in the Known vulnerabilities table
  });

  it('caps the shown affected-artifacts list at 25 paths and adds a "+N more" note', () => {
    const many: WaltzComponent = {
      nameVersion: 'example-widepath:1.0.0',
      maxVulnRating: 'High',
      remediationAction: null,
      instancePaths: Array.from({ length: 30 }, (_, i) => `/app/services/svc-${i}/package-lock.json`),
      vulnerabilities: [],
    };
    const wiki = buildDescriptionWiki(many);
    expect(wiki).toContain('h3. Affected artifacts (30 total — showing top 25)');
    expect(wiki).toContain('+5 more not shown');
    expect(wiki).toContain('/app/services/svc-0/package-lock.json');
    expect(wiki).not.toContain('/app/services/svc-29/package-lock.json');
  });
});
```

- [ ] **Step 2: Implement in `src/utils/waltzReport.ts`**

```ts
import { createHash } from 'crypto';
import { markdownToJiraWiki } from './markdownToJiraWiki'; // add alongside waltzReport.ts's existing top-of-file imports

const MAX_LABEL_LENGTH = 250; // safety margin under Jira's actual label length limit
const MAX_CVES_SHOWN = 10;
const MAX_ARTIFACTS_SHOWN = 25; // mirrors MAX_CVES_SHOWN's "+N more" pattern for the artifact-paths list
const LABEL_HASH_LENGTH = 6; // hex chars appended to disambiguate labels that sanitize to the same text

// sanitizeComponentLabel()'s character-collapsing is lossy (e.g. Maven "my_lib" and "my-lib" both
// become "my-lib" once the underscore is replaced by a hyphen), so two distinct components can land
// on the identical readable label — silently mismatching one to the other's existing ticket during
// dedup. This 6-hex-char suffix, derived from the *raw* nameVersion, keeps the label human-readable
// while making that collision cryptographically negligible (component labels stay literal, not fully
// hashed, per the already-settled design point above).
function labelHashSuffix(nameVersion: string): string {
  return createHash('sha256').update(nameVersion).digest('hex').slice(0, LABEL_HASH_LENGTH);
}

export function sanitizeComponentLabel(nameVersion: string): string {
  const sanitized = nameVersion
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const suffix = `-${labelHashSuffix(nameVersion)}`;
  const readableBudget = MAX_LABEL_LENGTH - 'oss-dep-'.length - suffix.length;
  const readable = sanitized.length > readableBudget ? sanitized.slice(0, readableBudget) : sanitized;
  return `oss-dep-${readable}${suffix}`;
}

export function buildLabels(component: WaltzComponent, templateLabels: string[] = []): string[] {
  const own = ['oss-dependency', sanitizeComponentLabel(component.nameVersion)];
  return [...new Set([...own, ...templateLabels])];
}

export function buildSummary(component: WaltzComponent): string {
  return `[OSS] ${component.nameVersion} — ${component.maxVulnRating}`;
}

function sortVulnerabilities(vulns: WaltzVulnerability[]): WaltzVulnerability[] {
  return [...vulns].sort((a, b) => {
    const ratingDiff = vulnRatingRank(b.overallSeverity ?? 'None') - vulnRatingRank(a.overallSeverity ?? 'None');
    if (ratingDiff !== 0) return ratingDiff;
    const scoreDiff = (b.cvssV3Score ?? -1) - (a.cvssV3Score ?? -1);
    if (scoreDiff !== 0) return scoreDiff;
    return a.cveId.localeCompare(b.cveId);
  });
}

// Authored as Markdown (headings, bullets, a real pipe table) and converted once at the end via
// markdownToJiraWiki() — avoids hand-writing Jira's ||table|| syntax; use **bold** (not Jira's
// single-asterisk bold) in the Markdown source since the converter's inline() pass would otherwise
// mistake a lone-asterisk span for italics.
export function buildDescriptionWiki(component: WaltzComponent): string {
  const lines: string[] = [];
  const sorted = sortVulnerabilities(component.vulnerabilities);

  lines.push('### Max Vuln Rating');
  lines.push(component.maxVulnRating);
  lines.push('');

  // Surfaces *why* this ticket exists at a glance, ahead of the full artifact/CVE lists below.
  lines.push('### Most Critical Vulnerability');
  if (sorted.length === 0) {
    lines.push('No CVE-level detail was reported for this component.');
  } else {
    const top = sorted[0];
    lines.push(`**${top.cveId}** — ${top.cveSummary ?? 'No summary reported.'}`);
  }
  lines.push('');

  const artifactTotal = component.instancePaths.length;
  lines.push(`### Affected artifacts (${artifactTotal} total${artifactTotal > MAX_ARTIFACTS_SHOWN ? ` — showing top ${MAX_ARTIFACTS_SHOWN}` : ''})`);
  if (artifactTotal === 0) {
    lines.push('No affected artifact paths were reported for this component.');
  } else {
    for (const p of component.instancePaths.slice(0, MAX_ARTIFACTS_SHOWN)) lines.push(`- ${p}`);
    if (artifactTotal > MAX_ARTIFACTS_SHOWN) lines.push(`+${artifactTotal - MAX_ARTIFACTS_SHOWN} more not shown`);
  }
  lines.push('');

  const total = component.vulnerabilities.length;
  lines.push(`### Known vulnerabilities (${total} total${total > MAX_CVES_SHOWN ? ` — showing top ${MAX_CVES_SHOWN}` : ''})`);
  if (total === 0) {
    lines.push('No CVE-level detail was reported for this component.');
  } else {
    lines.push('| CVE | Severity | CVSS | Fixed Version |');
    lines.push('| --- | --- | --- | --- |');
    for (const v of sorted.slice(0, MAX_CVES_SHOWN)) {
      const score = v.cvssV3Score != null ? String(v.cvssV3Score) : 'n/a';
      lines.push(`| ${v.cveId} | ${v.overallSeverity ?? 'Unknown'} | ${score} | ${v.fixedVersion ?? 'n/a'} |`);
    }
    if (total > MAX_CVES_SHOWN) {
      lines.push('');
      lines.push(`+${total - MAX_CVES_SHOWN} more not shown`);
    }
  }
  lines.push('');
  lines.push('### Component');
  lines.push(component.nameVersion);

  return markdownToJiraWiki(lines.join('\n'));
}
```

- [ ] **Step 3: Run tests, then commit**

```bash
npm test -- waltzReport
git add src/utils/waltzReport.ts src/test/waltzReport.test.ts
git commit -m "feat: build Waltz OSS ticket summary/description/labels"
```

---

## Task 7: Dedup helpers (TDD)

**Files:**
- Modify: `src/test/waltzReport.test.ts`
- Modify: `src/utils/waltzReport.ts`

Mirrors the Veracode import's `chunkIssueIds` / `buildDedupJql` / `extractDedupMap`, but keyed on the sanitized component label instead of a numeric issue id. Because component-derived labels aren't guaranteed to be JQL-safe unquoted the way Veracode's pure-numeric ids are, the JQL values here are **quoted**.

- [ ] **Step 1: Add failing tests**

```ts
import {
  chunkComponentLabels, buildDedupJql, extractDedupMap, buildReviewRows, sanitizeComponentLabel,
  DEDUP_CHUNK_SIZE,
} from '../utils/waltzReport';

describe('chunkComponentLabels', () => {
  it('chunks into groups of DEDUP_CHUNK_SIZE', () => {
    const labels = Array.from({ length: 85 }, (_, i) => `oss-dep-example-${i}`);
    const chunks = chunkComponentLabels(labels);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(DEDUP_CHUNK_SIZE);
    expect(chunks[2]).toHaveLength(5);
  });
});

describe('buildDedupJql', () => {
  it('quotes each label and ANDs onto project + issuetype', () => {
    const jql = buildDedupJql('PROJ', ['oss-dep-example-lib-1-2-3', 'oss-dep-example-io-4-5-0']);
    expect(jql).toBe(
      'project = PROJ AND labels in ("oss-dep-example-lib-1-2-3", "oss-dep-example-io-4-5-0")',
    );
  });
});

describe('extractDedupMap', () => {
  it('maps each already-ticketed label to the ticket key from search results', () => {
    const issues = [
      { key: 'PROJ-1', fields: { labels: ['oss-dependency', 'oss-dep-example-lib-1-2-3'] } },
      { key: 'PROJ-2', fields: { labels: ['oss-dependency', 'oss-dep-example-io-4-5-0'] } },
    ];
    const map = extractDedupMap(issues);
    expect(map.get('oss-dep-example-lib-1-2-3')).toBe('PROJ-1');
    expect(map.get('oss-dep-example-io-4-5-0')).toBe('PROJ-2');
  });
});

describe('buildReviewRows', () => {
  it('marks components with an existing ticket as already-ticketed (id prefix A) and excluded by default', async () => {
    const components = await parseWaltzReport(fixtureBuffer('sample-report.xlsx'));
    const filtered = filterComponents(components, { minVulnRating: 'High', includeRemediationActions: ['', 'Remediate'] });
    const dedupMap = new Map([[sanitizeComponentLabel('example-lib:1.2.3'), 'PROJ-1']]);
    const rows = buildReviewRows(filtered, dedupMap);

    const exampleLibRow = rows.find(r => r.nameVersion === 'example-lib:1.2.3')!;
    expect(exampleLibRow.id).toBe('A1');
    expect(exampleLibRow.existingTicketKey).toBe('PROJ-1');
    expect(exampleLibRow.included).toBe(false);
    expect(exampleLibRow.summary).toContain('example-lib:1.2.3');
    expect(exampleLibRow.labels).toContain(sanitizeComponentLabel('example-lib:1.2.3'));

    const exampleIoRow = rows.find(r => r.nameVersion === 'example-io:4.5.0')!;
    expect(exampleIoRow.id).toBe('1'); // new candidates numbered separately from already-ticketed ones
    expect(exampleIoRow.existingTicketKey).toBeNull();
    expect(exampleIoRow.included).toBe(true);
  });

  it('merges template labels into each row', async () => {
    const components = await parseWaltzReport(fixtureBuffer('sample-report.xlsx'));
    const filtered = filterComponents(components, { minVulnRating: 'High', includeRemediationActions: ['', 'Remediate'] });
    const rows = buildReviewRows(filtered, new Map(), ['team-payments']);
    expect(rows.every(r => r.labels.includes('team-payments'))).toBe(true);
  });
});
```

- [ ] **Step 2: Implement in `src/utils/waltzReport.ts`**

```ts
export const DEDUP_CHUNK_SIZE = 40;

// Defined here (alongside the other batch-shaped constants) and imported by waltzHandler.ts, rather
// than duplicated as a local constant there, so the ticket-creation cap and the review-screen
// truncation applied in Task 9 can never drift apart.
export const BATCH_LIMIT = 50;

export function chunkComponentLabels(labels: string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < labels.length; i += DEDUP_CHUNK_SIZE) {
    chunks.push(labels.slice(i, i + DEDUP_CHUNK_SIZE));
  }
  return chunks;
}

export function buildDedupJql(projectKey: string, labels: string[]): string {
  const quoted = labels.map(l => `"${l}"`).join(', ');
  return `project = ${projectKey} AND labels in (${quoted})`;
}

interface JqlIssueLike {
  key: string;
  fields: { labels?: string[] };
}

export function extractDedupMap(issues: JqlIssueLike[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const issue of issues) {
    for (const label of issue.fields.labels ?? []) {
      if (!label.startsWith('oss-dep-')) continue;
      if (!map.has(label)) map.set(label, issue.key); // first match wins if somehow duplicated
    }
  }
  return map;
}

// Lives here (rather than in sessionState.ts, where the other session-related types live) so that
// buildReviewRows() below can produce it directly without a type-only circular import between this
// file and sessionState.ts — mirrors the same layout decision made for VeracodeReviewRow.
// sessionState.ts re-exports the type for callers that expect it there.
export interface WaltzReviewRow {
  id: string; // '1'..'N' new candidates, 'A1'..'Am' already-ticketed
  nameVersion: string;
  maxVulnRating: string;
  summary: string;
  labels: string[];
  descriptionWiki: string;
  existingTicketKey: string | null;
  included: boolean; // whether this row will be (re)created if the batch runs
}

export function buildReviewRows(
  components: WaltzComponent[],
  dedupMap: Map<string, string>,
  templateLabels: string[] = [],
): WaltzReviewRow[] {
  const rows: WaltzReviewRow[] = [];
  let newIndex = 0;
  let ticketedIndex = 0;
  for (const component of components) {
    const label = sanitizeComponentLabel(component.nameVersion);
    const existingTicketKey = dedupMap.get(label) ?? null;
    rows.push({
      id: existingTicketKey ? `A${++ticketedIndex}` : `${++newIndex}`,
      nameVersion: component.nameVersion,
      maxVulnRating: component.maxVulnRating,
      summary: buildSummary(component),
      labels: buildLabels(component, templateLabels),
      descriptionWiki: buildDescriptionWiki(component),
      existingTicketKey,
      included: existingTicketKey === null,
    });
  }
  return rows;
}
```

- [ ] **Step 3: Run tests, then commit**

```bash
npm test -- waltzReport
git add src/utils/waltzReport.ts src/test/waltzReport.test.ts
git commit -m "feat: add Waltz OSS report dedup + review-row helpers"
```

---

## Task 8: `sessionState.ts` additions (TDD)

**Files:**
- Modify: `src/test/JiraParticipant.test.ts`
- Modify: `src/participant/sessionState.ts`

Mirrors `VeracodeTemplateSelectionSession` / `VeracodeReviewSession` / `buildVeracodeReviewTable` / `parseVeracodeReviewInput` / `applyVeracodeToggle` exactly.

- [ ] **Step 1: Add failing tests to `src/test/JiraParticipant.test.ts`**

```ts
import {
  buildWaltzReviewTable, parseWaltzReviewInput, applyWaltzToggle,
} from '../participant/sessionState';
import type { WaltzReviewRow } from '../utils/waltzReport';

const sampleRows: WaltzReviewRow[] = [
  {
    id: 'A1',
    nameVersion: 'example-lib:1.2.3',
    maxVulnRating: 'Critical',
    summary: '[OSS] example-lib:1.2.3 — Critical',
    labels: ['oss-dependency', 'oss-dep-example-lib-1-2-3'],
    descriptionWiki: 'h3. Max Vuln Rating\nCritical',
    existingTicketKey: 'PROJ-1',
    included: false,
  },
  {
    id: '1',
    nameVersion: 'example-io:4.5.0',
    maxVulnRating: 'High',
    summary: '[OSS] example-io:4.5.0 — High',
    labels: ['oss-dependency', 'oss-dep-example-io-4-5-0'],
    descriptionWiki: 'h3. Max Vuln Rating\nHigh',
    existingTicketKey: null,
    included: true,
  },
];

describe('buildWaltzReviewTable', () => {
  it('splits already-ticketed rows from new rows into separate tables', () => {
    const table = buildWaltzReviewTable(sampleRows);
    expect(table).toContain('### Already ticketed');
    expect(table).toContain('PROJ-1');
    expect(table).toContain('### New — will create');
    expect(table).toContain('example-io:4.5.0');
    expect(table).toContain('**1** ticket(s) will be created.');
  });

  it('links the existing ticket key when a baseUrl is provided', () => {
    const table = buildWaltzReviewTable(sampleRows, 'https://jira.example.com');
    expect(table).toContain('[PROJ-1](https://jira.example.com/browse/PROJ-1)');
  });

  it('shows an explanatory line instead of an empty table when every match already has a ticket', () => {
    const allTicketed = sampleRows.filter(r => r.existingTicketKey !== null);
    const table = buildWaltzReviewTable(allTicketed);
    expect(table).toContain('### New — will create');
    expect(table).toContain('_All matching components already have a ticket._');
    expect(table).not.toContain('| # | Component | Rating | Include? |');
  });

  it('notes when more new components matched than the BATCH_LIMIT-capped rows shown, and how to get the rest', () => {
    const table = buildWaltzReviewTable(sampleRows, undefined, 75); // 75 matched, only 1 "new" row present in sampleRows
    expect(table).toContain('74 more matched component(s) not shown');
    expect(table).toContain('re-run the import after this batch completes');
  });

  it('omits the truncation note when totalNewMatched is not given or matches what is shown', () => {
    expect(buildWaltzReviewTable(sampleRows)).not.toContain('more matched component(s) not shown');
    expect(buildWaltzReviewTable(sampleRows, undefined, 1)).not.toContain('more matched component(s) not shown');
  });

  it('warns on the review screen itself when included rows exceed BATCH_LIMIT, not just in the completion summary', () => {
    const manyIncluded: WaltzReviewRow[] = Array.from({ length: 51 }, (_, i) => ({
      id: `${i + 1}`,
      nameVersion: `example-pkg-${i}:1.0.0`,
      maxVulnRating: 'High',
      summary: `[OSS] example-pkg-${i}:1.0.0 — High`,
      labels: ['oss-dependency'],
      descriptionWiki: '',
      existingTicketKey: null,
      included: true,
    }));
    const table = buildWaltzReviewTable(manyIncluded);
    expect(table).toContain('Only the first 50');
  });
});

describe('parseWaltzReviewInput', () => {
  it('recognizes ok/cancel and toggle-id lists', () => {
    expect(parseWaltzReviewInput('ok', ['A1', '1'])).toEqual({ action: 'ok' });
    expect(parseWaltzReviewInput('c', ['A1', '1'])).toEqual({ action: 'cancel' });
    expect(parseWaltzReviewInput('A1 1', ['A1', '1'])).toEqual({ action: 'toggle', ids: ['A1', '1'] });
    expect(parseWaltzReviewInput('nonsense', ['A1', '1'])).toEqual({ action: 'invalid' });
  });
});

describe('applyWaltzToggle', () => {
  it('flips included for the matching row ids only', () => {
    const toggled = applyWaltzToggle(sampleRows, ['1']);
    expect(toggled.find(r => r.id === '1')!.included).toBe(false);
    expect(toggled.find(r => r.id === 'A1')!.included).toBe(false); // unchanged
  });
});
```

- [ ] **Step 2: Implement in `src/participant/sessionState.ts`**

```ts
import type { WaltzComponent, WaltzReviewRow } from '../utils/waltzReport';
import { BATCH_LIMIT } from '../utils/waltzReport';

export interface WaltzTemplateSelectionSession {
  reportFileName: string;
  projectKey: string;
  components: WaltzComponent[]; // already filtered by minVulnRating/includeRemediationActions
  availableTemplates: Array<{ name: string; issueType: string }>;
  availableIssueTypes: string[];
}

export interface WaltzReviewSession {
  projectKey: string;
  issueType: string;
  templateName: string | null;
  additionalFields: Record<string, unknown>; // resolved template fields (labels merged in per-row already)
  rows: WaltzReviewRow[]; // "new" rows are already capped at BATCH_LIMIT by the caller (Task 9) — see totalNewMatched
  totalNewMatched: number; // total new (not-yet-ticketed) components the report matched, before the BATCH_LIMIT cap
}

export function buildWaltzReviewTable(rows: WaltzReviewRow[], baseUrl?: string, totalNewMatched?: number): string {
  const ticketed = rows.filter(r => r.existingTicketKey !== null);
  const fresh = rows.filter(r => r.existingTicketKey === null);
  const lines: string[] = [];

  if (ticketed.length > 0) {
    lines.push('### Already ticketed');
    lines.push('| # | Component | Rating | Ticket | Include? |');
    lines.push('|---|-----------|--------|--------|----------|');
    for (const r of ticketed) {
      const ticketRef = baseUrl ? `[${r.existingTicketKey}](${baseUrl}/browse/${r.existingTicketKey})` : r.existingTicketKey;
      lines.push(`| ${r.id} | ${r.nameVersion} | ${r.maxVulnRating} | ${ticketRef} | ${r.included ? '✓ re-create' : '_excluded_'} |`);
    }
    lines.push('');
  }

  lines.push('### New — will create');
  if (fresh.length === 0) {
    lines.push('_All matching components already have a ticket._');
  } else {
    lines.push('| # | Component | Rating | Include? |');
    lines.push('|---|-----------|--------|----------|');
    for (const r of fresh) {
      lines.push(`| ${r.id} | ${r.nameVersion} | ${r.maxVulnRating} | ${r.included ? '✓' : '_excluded_'} |`);
    }
  }
  lines.push('');

  // Row-count truncation note: waltzHandler.ts caps "new" rows at BATCH_LIMIT before they ever reach
  // this table (see Task 9), so a report with more matches than BATCH_LIMIT would otherwise silently
  // drop the remainder with no signal. Surfacing the true total here, plus how to get the rest, closes
  // that gap — and reuses the existing dedup mechanism as the "resume" path (re-running after this
  // batch completes surfaces the next BATCH_LIMIT new candidates, since the ones just created are now
  // dedup-matched).
  if (totalNewMatched !== undefined && totalNewMatched > fresh.length) {
    lines.push(
      `_${totalNewMatched - fresh.length} more matched component(s) not shown — re-run the import after ` +
      `this batch completes; already-created tickets are automatically skipped next time._`,
    );
    lines.push('');
  }

  const willCreate = rows.filter(r => r.included).length;
  lines.push(`**${willCreate}** ticket(s) will be created.`);
  // Defensive backstop: "new" rows are already capped at BATCH_LIMIT above, but a user can still toggle
  // extra "already ticketed" rows back to "re-create", so this can still fire even with the cap in place.
  if (willCreate > BATCH_LIMIT) {
    lines.push('');
    lines.push(`_Only the first ${BATCH_LIMIT} included rows will be created this run — re-run the import afterward for the remainder._`);
  }
  lines.push('');
  lines.push('Reply **ok** to proceed, **(c)** to cancel, or a list of ids to toggle (e.g. `2 4` or `A1`).');

  return lines.join('\n');
}

export type WaltzReviewParseResult =
  | { action: 'ok' }
  | { action: 'cancel' }
  | { action: 'toggle'; ids: string[] }
  | { action: 'invalid' };

export function parseWaltzReviewInput(reply: string, rowIds: string[]): WaltzReviewParseResult {
  const normalized = reply.trim().toLowerCase();
  if (normalized === 'ok') return { action: 'ok' };
  if (normalized === 'c' || normalized === 'cancel') return { action: 'cancel' };

  const tokens = normalized.split(/[\s,]+/).filter(Boolean);
  const matched: string[] = [];
  for (const token of tokens) {
    const found = rowIds.find(id => id.toLowerCase() === token);
    if (found) matched.push(found);
  }
  if (matched.length === 0) return { action: 'invalid' };
  return { action: 'toggle', ids: matched };
}

// Pure so it's independently testable — the vscode-dependent handler just calls this and
// re-streams the result, rather than mutating WaltzReviewRow objects in place.
export function applyWaltzToggle(rows: WaltzReviewRow[], ids: string[]): WaltzReviewRow[] {
  const toggleSet = new Set(ids);
  return rows.map(r => (toggleSet.has(r.id) ? { ...r, included: !r.included } : r));
}
```

- [ ] **Step 3: Run tests, then commit**

```bash
npm test -- JiraParticipant
git add src/participant/sessionState.ts src/test/JiraParticipant.test.ts
git commit -m "feat: add Waltz OSS review-screen session types + pure helpers"
```

---

## Task 9: `src/participant/jira/waltzHandler.ts` (chat glue)

**Files:**
- Create: `src/participant/jira/waltzHandler.ts`

This file is `vscode`-dependent glue with no independent unit tests of its own (same as `veracodeHandler.ts`) — its pure logic already lives in, and is tested via, `waltzReport.ts` and `sessionState.ts`. It is exercised indirectly by the e2e suite. Mirrors `veracodeHandler.ts` function-for-function.

- [ ] **Step 1: Implement `src/participant/jira/waltzHandler.ts`**

```ts
import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TicketService } from '../../services/TicketService';
import type { IJiraClient } from '../../jira/IJiraClient';
import { TemplateService } from '../../templates/TemplateService';
import { FieldResolver } from '../../templates/FieldResolver';
import {
  parseWaltzReport, filterComponents, chunkComponentLabels, buildDedupJql, extractDedupMap, buildReviewRows,
  sanitizeComponentLabel, BATCH_LIMIT, type WaltzComponent,
} from '../../utils/waltzReport';
import type { WaltzTemplateSelectionSession, WaltzReviewSession } from '../sessionState';
import {
  isCancellation, pickEmailOption, buildWaltzReviewTable, parseWaltzReviewInput, applyWaltzToggle,
  extractCreatedKeyFromConfirmation,
} from '../sessionState';
import { resolveProjectKey } from './ticketContext';

const MAX_REPORT_BYTES = 20 * 1024 * 1024; // 20 MB

function getWaltzConfig(): { minVulnRating: string; includeRemediationActions: string[] } {
  const cfg = vscode.workspace.getConfiguration('ticketSidekick');
  return {
    minVulnRating: cfg.get<string>('waltz.minVulnRating') ?? 'High',
    includeRemediationActions: cfg.get<string[]>('waltz.includeRemediationActions') ?? ['', 'Remediate'],
  };
}

async function readAndFilterWaltzFile(filePath: string): Promise<WaltzComponent[]> {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_REPORT_BYTES) {
    throw new Error(`File exceeds the ${MAX_REPORT_BYTES / (1024 * 1024)} MB size limit.`);
  }
  const buffer = await fs.promises.readFile(filePath);
  // parseWaltzReport() itself also re-checks size (single source of truth used by the pure unit tests too).
  const components = await parseWaltzReport(buffer);
  return filterComponents(components, getWaltzConfig());
}

// Chat-only entry point's own file picker — mirrors veracodeHandler.ts's openVeracodeFilePicker.
async function openWaltzFilePicker(
  stream: vscode.ChatResponseStream,
): Promise<{ components: WaltzComponent[]; fileName: string } | null> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'OSS report': ['xlsx'] },
    defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads')),
    title: 'Select OSS Report (.xlsx)',
  });
  if (!uris || uris.length === 0) return null;

  try {
    const components = await readAndFilterWaltzFile(uris[0].fsPath);
    return { components, fileName: uris[0].fsPath.split(/[\\/]/).pop() ?? uris[0].fsPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag('jira.waltz', 'error', `Could not import report — ${uris[0].fsPath}`, { path: uris[0].fsPath, error: message });
    stream.markdown(`_Could not import report: ${message}_`);
    return null;
  }
}

export async function buildWaltzTemplateSession(
  components: WaltzComponent[],
  fileName: string,
  projectKey: string,
  jiraClient: IJiraClient,
): Promise<WaltzTemplateSelectionSession> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const availableTemplates: Array<{ name: string; issueType: string }> = (() => {
    if (!workspaceRoot) return [];
    try {
      return new TemplateService(workspaceRoot).loadTemplates().templates
        .map(t => ({ name: t.name, issueType: t.issueType ?? 'Bug' }));
    } catch (err) {
      logDiag('jira.waltz', 'warn', 'Could not load templates — proceeding without', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  })();

  let issueTypes: string[] = [];
  try {
    const project = await jiraClient.getProject(projectKey);
    issueTypes = project.issueTypes.filter(t => !t.subtask).map(t => t.name);
  } catch (err) {
    logDiag('jira.waltz', 'warn', `Could not fetch issue types — ${projectKey}, defaulting to 'Bug'`, {
      projectKey, error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    reportFileName: fileName,
    projectKey,
    components,
    availableTemplates,
    availableIssueTypes: issueTypes.length > 0 ? issueTypes : ['Bug'],
  };
}

export async function streamWaltzTemplateSelection(
  session: WaltzTemplateSelectionSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<void> {
  await ws.update('jira.session.waltzTemplateSelection', session);
  const { availableTemplates: templates, availableIssueTypes: issueTypes } = session;

  let optionsList = '';
  if (templates.length > 0) {
    optionsList += `**Templates:**\n${templates.map((t, i) => `${i + 1}. ${t.name} _(${t.issueType})_`).join('\n')}\n\n`;
  }
  const offset = templates.length;
  optionsList += `**Issue types (no template):**\n${issueTypes.map((t, i) => `${offset + i + 1}. ${t}`).join('\n')}\n\n`;

  stream.markdown(
    `Found **${session.components.length}** component(s) in \`${session.reportFileName}\` matching your rating/remediation filters ` +
    `for project **${session.projectKey}**.\n\n${optionsList}` +
    `Reply with a number to select a template or issue type, or **(c)** to cancel.\n\n<!-- jira:waltz-template -->`,
  );
}

// Entry point for the "importWaltzReport" operation. Handles both invocation paths:
//  1. Command-triggered — a WaltzTemplateSelectionSession is already in workspaceState (built by extension.ts).
//  2. Chat-only ("@jira import oss report" with no prior command) — opens its own file picker.
// projectKeyHint comes from the LLM-parsed intent.projectKey (e.g. "@jira import oss report for PROJ");
// resolveProjectKey() falls back to the defaultProject setting, then an input box, when it's null.
export async function handleImportWaltzReport(
  _request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
  jiraClient: IJiraClient,
  _ticketService: TicketService,
  ws: vscode.Memento,
  projectKeyHint: string | null = null,
): Promise<void> {
  const existing = ws.get<WaltzTemplateSelectionSession>('jira.session.waltzTemplateSelection');
  if (existing) {
    await streamWaltzTemplateSelection(existing, stream, ws);
    return;
  }

  const picked = await openWaltzFilePicker(stream);
  if (!picked) return;
  if (picked.components.length === 0) {
    stream.markdown(
      'No components in this report matched your current filters ' +
      '(`ticketSidekick.waltz.minVulnRating` / `ticketSidekick.waltz.includeRemediationActions`).',
    );
    return;
  }

  const projectKey = await resolveProjectKey(projectKeyHint, stream);
  if (!projectKey) {
    stream.markdown('_No project key provided — cancelled._');
    return;
  }

  const session = await buildWaltzTemplateSession(picked.components, picked.fileName, projectKey, jiraClient);
  await streamWaltzTemplateSelection(session, stream, ws);
}

async function findAlreadyTicketed(
  ticketService: TicketService,
  projectKey: string,
  components: WaltzComponent[],
): Promise<Map<string, string>> {
  const labels = components.map(c => sanitizeComponentLabel(c.nameVersion));
  const map = new Map<string, string>();
  for (const chunk of chunkComponentLabels(labels)) {
    if (chunk.length === 0) continue;
    const jql = buildDedupJql(projectKey, chunk);
    const result = await ticketService.searchTicketsRaw(jql, 100);
    const found = extractDedupMap(result.issues.map(i => ({ key: i.key, fields: { labels: i.fields.labels } })));
    for (const [label, key] of found) map.set(label, key);
  }
  return map;
}

export async function handleWaltzTemplateSelection(
  reply: string,
  session: WaltzTemplateSelectionSession,
  jiraClient: IJiraClient,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<void> {
  if (isCancellation(reply)) {
    await ws.update('jira.session.waltzTemplateSelection', undefined);
    stream.markdown('_Cancelled — no tickets were created._');
    return;
  }

  const n = parseInt(reply.trim(), 10);
  const pick = isNaN(n) ? null : pickEmailOption(n, session.availableTemplates, session.availableIssueTypes);
  if (!pick) {
    stream.markdown(`Didn't understand that reply.\n\n`);
    await streamWaltzTemplateSelection(session, stream, ws);
    return;
  }
  await ws.update('jira.session.waltzTemplateSelection', undefined);

  let additionalFields: Record<string, unknown> = {};
  let templateName: string | null = null;
  if (pick.kind === 'template') {
    templateName = pick.name;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    if (workspaceRoot) {
      try {
        const { templates } = new TemplateService(workspaceRoot).loadTemplates();
        const fullTemplate = templates.find(t => t.name === pick.name);
        if (fullTemplate) {
          const resolver = new FieldResolver(jiraClient, session.projectKey);
          additionalFields = await resolver.resolve(fullTemplate.defaultFields, fullTemplate.resolveFields);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('jira.waltz', 'warn', `Could not resolve template fields — ${pick.name}`, { templateName: pick.name, error: message });
        stream.markdown(
          `_Warning: could not resolve template fields — proceeding without them: ${message}_\n\n`,
        );
      }
    }
  }

  stream.markdown(`_Checking for already-ticketed components…_\n\n`);
  const templateLabels = Array.isArray(additionalFields.labels) ? additionalFields.labels as string[] : [];

  // The template session was already cleared above, so a failure here must degrade gracefully
  // (mirroring the template-field-resolution step above it) rather than throw with nothing left
  // to resume from.
  let dedupMap: Map<string, string>;
  try {
    dedupMap = await findAlreadyTicketed(ticketService, session.projectKey, session.components);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag('jira.waltz', 'warn', 'Could not check for already-ticketed components — proceeding without dedup', {
      projectKey: session.projectKey, error: message,
    });
    stream.markdown(`_Warning: could not check for already-ticketed components — proceeding without dedup: ${message}_\n\n`);
    dedupMap = new Map();
  }

  const allRows = buildReviewRows(session.components, dedupMap, templateLabels);
  const totalNewMatched = allRows.filter(r => r.existingTicketKey === null).length;
  // Cap "new" rows at BATCH_LIMIT so the review screen never shows (or risks silently creating) more
  // than one run's worth of tickets — already-ticketed rows are never capped. Re-running the import
  // after this batch completes surfaces the next BATCH_LIMIT new candidates for free, since the ones
  // just created are now dedup-matched.
  let newSeen = 0;
  const rows = allRows.filter(r => {
    if (r.existingTicketKey !== null) return true;
    newSeen++;
    return newSeen <= BATCH_LIMIT;
  });

  const reviewSession: WaltzReviewSession = {
    projectKey: session.projectKey,
    issueType: pick.issueType,
    templateName,
    additionalFields,
    rows,
    totalNewMatched,
  };
  await streamWaltzReview(reviewSession, stream, ws, baseUrl);
}

export async function streamWaltzReview(
  session: WaltzReviewSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<void> {
  await ws.update('jira.session.waltzReview', session);
  stream.markdown(`${buildWaltzReviewTable(session.rows, baseUrl, session.totalNewMatched)}\n\n<!-- jira:waltz-review -->`);
}

export async function handleWaltzReviewReply(
  reply: string,
  session: WaltzReviewSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<void> {
  const rowIds = session.rows.map(r => r.id);
  const decision = parseWaltzReviewInput(reply, rowIds);

  if (decision.action === 'invalid') {
    stream.markdown(
      `Didn't understand that. Reply **ok** to proceed, **(c)** to cancel, ` +
      `or a list of ids to toggle (e.g. \`2 4\` or \`A1\`).\n\n<!-- jira:waltz-review -->`,
    );
    return;
  }
  if (decision.action === 'cancel') {
    await ws.update('jira.session.waltzReview', undefined);
    stream.markdown('_Cancelled — no tickets were created._');
    return;
  }
  if (decision.action === 'toggle') {
    session.rows = applyWaltzToggle(session.rows, decision.ids);
    await streamWaltzReview(session, stream, ws, baseUrl);
    return;
  }

  // decision.action === 'ok'
  await ws.update('jira.session.waltzReview', undefined);
  await executeWaltzBatch(session, ticketService, stream, baseUrl);
}

export async function executeWaltzBatch(
  session: WaltzReviewSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  baseUrl?: string,
): Promise<void> {
  const toCreate = session.rows.filter(r => r.included).slice(0, BATCH_LIMIT);
  const excludedByUser = session.rows.filter(r => !r.included && r.existingTicketKey === null).length;
  const alreadyTicketedSkipped = session.rows.filter(r => !r.included && r.existingTicketKey !== null).length;

  if (toCreate.length === 0) {
    stream.markdown('_Nothing selected — no tickets were created._');
    return;
  }

  stream.markdown(`_Creating ${toCreate.length} ticket(s)…_\n\n`);
  let created = 0;
  let failed = 0;

  for (const row of toCreate) {
    try {
      const fields = { ...session.additionalFields, labels: row.labels, description: row.descriptionWiki };
      const confirmation = await ticketService.createTicket(session.projectKey, row.summary, session.issueType, fields);
      const key = extractCreatedKeyFromConfirmation(confirmation);
      const keyRef = key && baseUrl ? `[${key}](${baseUrl}/browse/${key})` : (key ?? '?');
      stream.markdown(`✓ ${keyRef} — ${row.summary}\n\n`);
      created++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.waltz', 'error', `Ticket creation failed — ${row.nameVersion}`, { nameVersion: row.nameVersion, error: message });
      stream.markdown(`✗ ${row.nameVersion} — ${message}\n\n`);
      failed++;
    }
  }

  const total = session.rows.length;
  let summary =
    `${total} component(s) reviewed — **${created}** created, ${failed} failed, ` +
    `${excludedByUser} excluded by you, ${alreadyTicketedSkipped} already ticketed (skipped).`;
  if (session.rows.length > BATCH_LIMIT) {
    summary += `\n\n_Batch capped at ${BATCH_LIMIT} tickets per run — re-run the import to process the remainder._`;
  }
  logDiag('jira.waltz', failed > 0 ? 'warn' : 'info', `Waltz OSS import complete — ${created} created, ${failed} failed`, {
    total, created, failed, excludedByUser, alreadyTicketedSkipped,
  });
  stream.markdown(summary);
}
```

- [ ] **Step 2: Compile check**

```bash
npm run compile
```

Expected: No errors (file compiles against the existing `IJiraClient`/`TicketService`/`sessionState.ts` types).

- [ ] **Step 3: Commit**

```bash
git add src/participant/jira/waltzHandler.ts
git commit -m "feat: add waltzHandler.ts chat glue for OSS report import"
```

---

## Task 10: `llmHelpers.ts` — new `'importWaltzReport'` operation

**Files:**
- Modify: `src/participant/jira/llmHelpers.ts`

- [ ] **Step 1: Add to the `Operation` union**, alongside `'importVeracode'`:

```ts
  | 'importWaltzReport';
```

- [ ] **Step 2: Add `"importWaltzReport"` to the `INTENT_PROMPT`'s JSON-shape enum list**, alongside the other operation names (same line that already lists `"importVeracode"`).

- [ ] **Step 3: Add a description bullet to `INTENT_PROMPT`**, alongside the `importVeracode` bullet:

```text
- importWaltzReport: import a Waltz/SCA OSS report .xlsx export and create Jira tickets from its vulnerable components; triggered by "import oss report", "import waltz report", "oss report", "create tickets from oss report", "sca report"; only use this when the session is already loaded via command palette, or to trigger the chat's own file picker if no command was used; projectKey is extracted from the prompt the same as for createTicket when the user names a project (e.g. "import oss report for PROJ"), otherwise left null so the handler falls back to the default-project setting or an input box
```

- [ ] **Step 4: Run tests, then commit**

```bash
npm test -- llmHelpers
git add src/participant/jira/llmHelpers.ts
git commit -m "feat: add importWaltzReport operation + intent trigger phrases"
```

---

## Task 11: `JiraParticipant.ts` routing

**Files:**
- Modify: `src/participant/JiraParticipant.ts`

- [ ] **Step 1: Import the new handler functions + session types**, alongside the existing Veracode imports:

```ts
import {
  handleImportWaltzReport, handleWaltzTemplateSelection, handleWaltzReviewReply,
} from './jira/waltzHandler';
import type { WaltzTemplateSelectionSession, WaltzReviewSession } from './sessionState';
```

- [ ] **Step 2: Add session-detection blocks**, immediately after the Veracode blocks (this plan's Task 13 updates the "Detection order" note in `CLAUDE.md` to insert Waltz right after Veracode):

```ts
    // Waltz OSS report template/issue-type selection
    if (lastResponse.includes('<!-- jira:waltz-template -->')) {
      const templateSession = ws.get<WaltzTemplateSelectionSession>('jira.session.waltzTemplateSelection');
      if (templateSession) {
        await handleWaltzTemplateSelection(request.prompt, templateSession, jiraClient, ticketService, stream, ws, config.baseUrl);
        return;
      }
    }

    // Waltz OSS report review / selection screen
    if (lastResponse.includes('<!-- jira:waltz-review -->')) {
      const reviewSession = ws.get<WaltzReviewSession>('jira.session.waltzReview');
      if (reviewSession) {
        await handleWaltzReviewReply(request.prompt, reviewSession, ticketService, stream, ws, config.baseUrl);
        return;
      }
    }
```

- [ ] **Step 3: Add operation routing**, alongside the existing `importVeracode` branch:

```ts
    if (intent.operation === 'importWaltzReport') {
      await handleImportWaltzReport(request, stream, token, jiraClient, ticketService, ws, intent.projectKey);
      return;
    }
```

- [ ] **Step 4: Compile + run tests, then commit**

```bash
npm run compile && npm test
git add src/participant/JiraParticipant.ts
git commit -m "feat: route importWaltzReport + Waltz session detection in JiraParticipant"
```

---

## Task 12: `extension.ts` command registration

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Add imports**, alongside the existing Veracode imports:

```ts
import { parseWaltzReport, filterComponents } from './utils/waltzReport';
import type { WaltzTemplateSelectionSession } from './participant/sessionState';
```

- [ ] **Step 2: Register the command**, immediately after the `ticket-sidekick.importVeracodeReport` registration block:

```ts
  context.subscriptions.push(
    vscode.commands.registerCommand('ticket-sidekick.importWaltzReport', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'OSS report': ['xlsx'] },
        defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads')),
        title: 'Select OSS Report (.xlsx)',
      });
      if (!uris || uris.length === 0) return;
      const reportPath = uris[0].fsPath;

      const MAX_REPORT_BYTES = 20 * 1024 * 1024;
      let buffer: Buffer;
      try {
        const stat = await fs.promises.stat(reportPath);
        if (stat.size > MAX_REPORT_BYTES) {
          vscode.window.showErrorMessage(`Ticket Sidekick: Report exceeds the ${MAX_REPORT_BYTES / (1024 * 1024)} MB size limit.`);
          return;
        }
        buffer = await fs.promises.readFile(reportPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('extension', 'error', `Could not read OSS report — ${reportPath}`, { reportPath, error: message });
        vscode.window.showErrorMessage(`Ticket Sidekick: Could not read file: ${message}`);
        return;
      }

      const waltzCfg = vscode.workspace.getConfiguration('ticketSidekick');
      let components;
      try {
        const allComponents = await parseWaltzReport(buffer);
        components = filterComponents(allComponents, {
          minVulnRating: waltzCfg.get<string>('waltz.minVulnRating') ?? 'High',
          includeRemediationActions: waltzCfg.get<string[]>('waltz.includeRemediationActions') ?? ['', 'Remediate'],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('extension', 'error', `Could not parse OSS report — ${reportPath}`, { reportPath, error: message });
        vscode.window.showErrorMessage(`Ticket Sidekick: Could not parse OSS report: ${message}`);
        return;
      }

      if (components.length === 0) {
        vscode.window.showInformationMessage(
          'Ticket Sidekick: No components in this report matched your current rating/remediation filters ' +
          '(ticketSidekick.waltz.minVulnRating / ticketSidekick.waltz.includeRemediationActions).',
        );
        return;
      }

      const config = await configService.getConfig();
      if (!config.baseUrl || !config.token) {
        vscode.window.showErrorMessage('Ticket Sidekick: Configure Jira credentials first.');
        return;
      }

      let projectKey = waltzCfg.get<string>('jira.defaultProject') ?? '';
      if (!projectKey) {
        const entered = await vscode.window.showInputBox({
          prompt: 'Enter the Jira project key for the new tickets (e.g. PROJ)',
          placeHolder: 'PROJECT',
          ignoreFocusOut: true,
        });
        if (!entered) return;
        projectKey = entered;
      }

      const jiraClient = new JiraApiClient({
        baseUrl: config.baseUrl,
        authType: config.authType,
        token: config.token,
        onDiag: (level, message, details) => logDiag('jira.apiClient', level, message, details),
      });
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

      const availableTemplates: Array<{ name: string; issueType: string }> = (() => {
        if (!workspaceRoot) return [];
        try {
          return new TemplateService(workspaceRoot).loadTemplates().templates
            .map(t => ({ name: t.name, issueType: t.issueType ?? 'Bug' }));
        } catch (err) {
          logDiag('extension', 'warn', 'Could not load templates — proceeding without', {
            error: err instanceof Error ? err.message : String(err),
          });
          return [];
        }
      })();

      const issueTypes = await jiraClient.getProject(projectKey)
        .then(p => p.issueTypes.filter(t => !t.subtask).map(t => t.name))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('extension', 'warn', `Could not fetch issue types — ${projectKey}`, { projectKey, error: message });
          vscode.window.showWarningMessage(
            `Ticket Sidekick: Could not fetch issue types for ${projectKey} — will default to 'Bug'. ${message}`,
          );
          return [] as string[];
        });

      const session: WaltzTemplateSelectionSession = {
        reportFileName: path.basename(reportPath),
        projectKey,
        components,
        availableTemplates,
        availableIssueTypes: issueTypes.length > 0 ? issueTypes : ['Bug'],
      };

      await context.workspaceState.update('jira.session.waltzTemplateSelection', session);
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: '@jira import oss report' });
    }),
  );
```

- [ ] **Step 3: Compile + run full test suite, then commit**

```bash
npm run compile && npm test
git add src/extension.ts
git commit -m "feat: register ticket-sidekick.importWaltzReport command"
```

---

## Task 13: Documentation updates

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: `README.md`** — add a new "OSS report import" section mirroring the existing "Veracode report import" section: how to trigger it (command palette or `@jira import oss report`), what the settings do, and a short description of the review-screen flow.

- [ ] **Step 2: `CLAUDE.md` — Key files table** — add rows for `src/utils/waltzReport.ts` and `src/participant/jira/waltzHandler.ts`, following the existing style of the `veracodeReport.ts` / `veracodeHandler.ts` rows.

- [ ] **Step 3: `CLAUDE.md` — VS Code settings keys table** — add a new "OSS report settings" subsection with `ticketSidekick.waltz.minVulnRating` and `ticketSidekick.waltz.includeRemediationActions`, mirroring the "Veracode settings" subsection.

- [ ] **Step 4: `CLAUDE.md` — Jira sessions table** — add two rows:

| Session | workspaceState key | Tag in response |
| --- | --- | --- |
| `WaltzTemplateSelectionSession` | `jira.session.waltzTemplateSelection` | `<!-- jira:waltz-template -->` |
| `WaltzReviewSession` | `jira.session.waltzReview` | `<!-- jira:waltz-review -->` |

and update the "Detection order" sentence to insert `→ Waltz template selection → Waltz review` right after `→ veracode template selection → veracode review`.

- [ ] **Step 5: `CLAUDE.md` — add a "Waltz OSS report import" flow section**, mirroring the existing "Veracode report import" section, describing the 3-phase flow (template selection → dedup + review → batch creation) and the known limitation that instance/vulnerability detail depends entirely on what the two optional sheets contain.

- [ ] **Step 6: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document OSS report import feature"
```

---

## Worked example (for UX sign-off before implementation starts)

This is a fully fictitious example showing what a user would see, end to end, using the `example-lib:1.2.3` row from the fixture in Task 3. **Please review this and confirm or adjust before implementation begins.**

**1. Template/issue-type selection prompt** (after running the command and picking a file):

> Found **3** component(s) in `oss-report.xlsx` matching your rating/remediation filters for project **PROJ**.
>
> **Templates:**
> 1. Security Finding _(Bug)_
>
> **Issue types (no template):**
> 2. Bug
> 3. Task
>
> Reply with a number to select a template or issue type, or **(c)** to cancel.

**2. Review screen** (after picking a template):

> ### New — will create
> | # | Component | Rating | Include? |
> |---|-----------|--------|----------|
> | 1 | example-lib:1.2.3 | Critical | ✓ |
> | 2 | example-io:4.5.0 | High | ✓ |
> | 3 | example-http:3.3.3 | High | ✓ |
>
> **3** ticket(s) will be created.
>
> Reply **ok** to proceed, **(c)** to cancel, or a list of ids to toggle (e.g. `2 4` or `A1`).

**3. Created ticket for `example-lib:1.2.3`** — summary:

> `[OSS] example-lib:1.2.3 — Critical`

— description (rendered Jira wiki output; authored as Markdown internally and converted via `markdownToJiraWiki()`):

> **h3. Max Vuln Rating**
> Critical
>
> **h3. Most Critical Vulnerability**
> **CVE-2099-0001** — Improper input validation may allow remote code execution via crafted deserialization payloads.
>
> **h3. Affected artifacts (1 total)**
> * /app/services/checkout/package-lock.json
>
> **h3. Known vulnerabilities (2 total)**
>
> | CVE | Severity | CVSS | Fixed Version |
> |---|---|---|---|
> | CVE-2099-0001 | Critical | 9.8 | 1.2.4 |
> | CVE-2099-0002 | High | 7.5 | 1.2.4 |
>
> **h3. Component**
> example-lib:1.2.3

— labels: `oss-dependency`, `oss-dep-example-lib-1-2-3-<hash>` (a 6-hex-char disambiguating suffix — see "Component labels" below; plus any labels from the chosen template).

**4. Batch completion message** (ticket ids link to Jira when `ticketSidekick.jira.baseUrl` is configured, falling back to a plain key otherwise):

> ✓ [PROJ-42](https://jira.example.com/browse/PROJ-42) — [OSS] example-lib:1.2.3 — Critical
>
> ✓ [PROJ-43](https://jira.example.com/browse/PROJ-43) — [OSS] example-io:4.5.0 — High
>
> ✓ [PROJ-44](https://jira.example.com/browse/PROJ-44) — [OSS] example-http:3.3.3 — High
>
> 3 component(s) reviewed — **3** created, 0 failed, 0 excluded by you, 0 already ticketed (skipped).

**All UX questions resolved — plan ready for implementation:**
- ✅ Review-screen toggle mechanism — identical to the Veracode import (`ok` / `c`|`cancel` / space-or-comma-separated row ids to flip inclusion).
- ✅ Ticket summary/title format: `[OSS] <name:version> — <Max Vuln Rating>`, e.g. `[OSS] example-lib:1.2.3 — Critical` — short, no embedded CVE count or CVE text (avoids truncation risk from the unbounded `CVE Summary` cell).
- ✅ Description keeps `h3.`-per-section structure; the "Known vulnerabilities" section renders as a real table (`CVE` / `Severity` / `CVSS` / `Fixed Version`) rather than a bullet list, built from Markdown and converted via the existing `markdownToJiraWiki()` utility rather than hand-authored Jira wiki table syntax.
- ✅ Batch completion message links each created ticket id to Jira (`[KEY](baseUrl/browse/KEY)`) when a base URL is configured, matching the existing `[KEY](baseUrl/browse/KEY)` convention used elsewhere in the extension (e.g. `TicketService.formatIssueLinkLine`, `buildWaltzReviewTable`'s "Already ticketed" column). `executeWaltzBatch` takes an optional `baseUrl` parameter threaded from `handleWaltzReviewReply` for this — new-feature design only; see the "Open points" section above for retrofitting this to the shipped Veracode import and other existing creation confirmations.
- ✅ Description leads with a **"Most Critical Vulnerability"** section (`CVE Id` + `CVE Summary` of the single highest-severity/CVSS finding), ahead of the artifact list and the full CVE table, so the ticket makes clear at a glance what it's actually for.
- ✅ "No CVE-level detail was reported for this component." / "No summary reported." fallback wording — kept as originally proposed.

---

## Deferred / Open Questions

### From 2026-08-13 review

- **Report schema validated against only one real export** — Sample data disclosure note (P2, adversarial, confidence 75)

  Every sheet name and column header in this plan's schema — and the whole TDD fixture suite — was derived from inspecting one real Waltz export. A schema drift in a different Waltz version, report template, or locale would break parsing for some users with no test coverage to catch it in advance, surfacing only as an unhelpful runtime parse error. Needs validation against a second real export, ideally before or shortly after shipping.

---
