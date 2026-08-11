# Veracode Detailed Report → Jira Tickets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user import a Veracode "Detailed Report" XML export, review the reported static-analysis flaws (filtered by severity + remediation status), pick which ones are relevant, and bulk-create one Jira ticket per selected flaw with all relevant report data — reusing the existing `@jira` participant's template/creation pipeline. No changes to `IJiraClient`/`JiraApiClient`/`MockJiraClient` are required.

**Architecture:** Mirrors the existing `.eml` email-import feature exactly:

```text
VS Code command "ticket-sidekick.importVeracodeReport"
  → file picker (*.xml)
  → src/utils/veracodeReport.ts:parseVeracodeReport() + filterFlaws()   (pure, no vscode import)
  → build VeracodeTemplateSelectionSession → workspaceState → open chat "@jira import veracode report"

JiraParticipant.ts (routing)
  → new Operation 'importVeracode' in llmHelpers.ts (chat-only entry point mirrors "addEmailComment": opens its own file
    picker if no session exists yet, so `@jira import veracode report` also works without the command)
  → src/participant/jira/veracodeHandler.ts
      Phase 1: template selection      (VeracodeTemplateSelectionSession, marker <!-- jira:veracode-template -->)
      Phase 2: de-dup search + review  (VeracodeReviewSession,           marker <!-- jira:veracode-review -->)
      Phase 3: batch creation          (loops TicketService.createTicket, mirrors executeCleanupBatch)
                    ↓
              TicketService.createTicket / searchTicketsRaw   (existing, unmodified)
              FieldResolver.resolve                            (existing, unmodified)
              TemplateService.loadTemplates                    (existing, unmodified)
```

**Tech Stack:** TypeScript, `fast-xml-parser` (new dependency), VS Code Extension API, Vitest (unit tests).

**Security notes (OWASP-conscious):**
- `fast-xml-parser` is a pure-JS parser with no DTD/external-entity resolution — inherently immune to classic XXE.
- Defense in depth: reject any input containing a literal `<!DOCTYPE` or `<!ENTITY` (case-insensitive) *before* parsing.
- Cap input size at 20 MB before parsing (resource-exhaustion / decompression-bomb style protection).
- All ticket content (flaw description, category recommendation) is Jira-wiki-escaped the same way existing email/comment content is — no raw HTML/script injection risk since Jira renders wiki markup, not HTML.

**Sample data disclosure note:** All XML fixtures, worked examples, and dummy data in this plan use **entirely fictitious** identifiers (`ExampleCorp`, `com/example/webapp/...`, `ExampleApp`, made-up `issueid` values, invented CWE examples with real public CWE IDs/names since those are public taxonomy, not project-specific data). Nothing here is copied from any real scanned project or its real findings.

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `package.json` | MODIFY | Add `fast-xml-parser` dependency; add `ticket-sidekick.importVeracodeReport` command; add `ticketSidekick.veracode.*` settings |
| `src/utils/veracodeReport.ts` | CREATE | Pure domain logic: XML parsing, filtering, short-label/summary/description/label builders, dedup helpers |
| `src/test/fixtures/veracode/sample-report.xml` | CREATE | Synthetic Detailed Report fixture (New severity-5, Fixed severity-4, Reopened severity-4 w/ missing sourcefile) |
| `src/test/fixtures/veracode/malformed-report.xml` | CREATE | Truncated/invalid XML fixture for error-path tests |
| `src/test/fixtures/veracode/doctype-report.xml` | CREATE | Fixture containing a `<!DOCTYPE` declaration, for XXE-guard tests |
| `src/test/veracodeReport.test.ts` | CREATE | Unit tests (TDD) for all pure functions in `veracodeReport.ts` |
| `src/participant/sessionState.ts` | MODIFY | Add `VeracodeTemplateSelectionSession`, `VeracodeReviewSession`, `VeracodeReviewRow` types; add `buildVeracodeReviewTable`, `parseVeracodeReviewInput` pure helpers |
| `src/test/JiraParticipant.test.ts` | MODIFY | Add tests for the new pure `sessionState.ts` helpers (table building, toggle parsing) |
| `src/participant/jira/veracodeHandler.ts` | CREATE | Chat glue: file picker (chat-only entry), template selection, dedup search + review screen, batch creation |
| `src/participant/jira/llmHelpers.ts` | MODIFY | Add `'importVeracode'` to `Operation` union + `INTENT_PROMPT` trigger phrases |
| `src/participant/JiraParticipant.ts` | MODIFY | Import + route `importVeracode`; add session-detection blocks for the two new markers |
| `src/extension.ts` | MODIFY | Register `ticket-sidekick.importVeracodeReport` command (file picker → parse → filter → session → open chat) |
| `README.md` | MODIFY | New "Veracode report import" section |
| `CLAUDE.md` | MODIFY | Key files table, settings table, session-state table entries |

---

## Task 1: Add `fast-xml-parser` dependency

**Files:**
- Modify: `package.json` (dependency added by npm)

- [ ] **Step 1: Install fast-xml-parser**

```bash
npm install fast-xml-parser
```

Expected: `fast-xml-parser` appears in `package.json` `dependencies` (ships its own TypeScript types — no `@types/*` package needed).

- [ ] **Step 2: Verify compile is still clean**

```bash
npm run compile
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add fast-xml-parser dependency for Veracode report import"
```

---

## Task 2: Settings + command scaffolding in `package.json`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the command entry**

In the `contributes.commands` array, alongside `ticket-sidekick.importEml`:

```json
{
  "command": "ticket-sidekick.importVeracodeReport",
  "title": "Ticket Sidekick: Create Jira tickets from Veracode report (.xml)"
}
```

- [ ] **Step 2: Add a new "veracode" configuration section**

In `contributes.configuration`, add a new section alongside the existing `"email"` one:

```json
{
  "id": "veracode",
  "title": "Ticket Sidekick — Veracode",
  "properties": {
    "ticketSidekick.veracode.minSeverity": {
      "type": "number",
      "default": 4,
      "minimum": 0,
      "maximum": 5,
      "description": "Minimum Veracode severity (0=Informational … 5=Very High) to include when importing a Detailed Report. Flaws below this are filtered out by default (still visible in the raw XML)."
    },
    "ticketSidekick.veracode.includeRemediationStatuses": {
      "type": "array",
      "items": { "type": "string" },
      "default": ["New", "Open", "Reopened"],
      "description": "Veracode remediation_status values to include when importing a Detailed Report (e.g. exclude 'Fixed' or 'Mitigated'). Valid values: Cannot Reproduce, Fixed, Mitigated, New, Open, Potential False Positive, Remediated by User, Reopened, Reviewed - No Action Taken."
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
git commit -m "feat: add Veracode import command + settings scaffolding"
```

---

## Task 3: XML parsing + filtering (TDD, pure — no `vscode` import)

**Files:**
- Create: `src/test/fixtures/veracode/sample-report.xml`
- Create: `src/test/fixtures/veracode/malformed-report.xml`
- Create: `src/test/fixtures/veracode/doctype-report.xml`
- Create: `src/test/veracodeReport.test.ts`
- Create: `src/utils/veracodeReport.ts`

All fixtures below use **entirely fictitious** identifiers (`ExampleCorp`, `ExampleApp`, `com/example/webapp/...`). CWE ids/names are the real, public MITRE taxonomy (CWE-89, CWE-798, etc.) since those are public standard identifiers, not project-specific data.

- [ ] **Step 1: Create `src/test/fixtures/veracode/sample-report.xml`**

Three flaws: one **New** severity-5 (included by default), one **Fixed** severity-4 (excluded by default status filter), one **Reopened** severity-4 missing `sourcefile` (exercises the `module` fallback).

```xml
<?xml version="1.0" encoding="UTF-8"?>
<detailedreport xmlns="https://analysiscenter.veracode.com/schema/2.0/detailedreport"
                 report_format_version="1.5" app_name="ExampleApp" account_id="999999"
                 first_build_submitted_date="2026-04-01T09:00:00.000-0000"
                 last_update_time="2026-05-01T10:00:00.000-0000">
  <static-analysis>
    <modules>
      <module name="ExampleApp.war" compiler="JAVAC" os="Java" architecture="Java"/>
    </modules>
  </static-analysis>
  <severity level="5">
    <category categoryid="20" categoryname="SQL Injection" pcirelated="true">
      <desc><para text="Untrusted input used to build a SQL statement."/></desc>
      <recommendations>
        <para text="Use parameterized queries or a properly configured ORM instead of building SQL from string concatenation."/>
        <para text="Apply strict allow-list input validation to any values that must be interpolated."/>
      </recommendations>
      <cwe cweid="89" cwename="Improper Neutralization of Special Elements used in an SQL Command ('SQL Injection')" owasp="A03:2021-Injection">
        <description>
          <para text="SQL injection allows an attacker to alter the intended query."/>
        </description>
        <staticflaws>
          <flaw severity="5" categoryname="SQL Injection" count="1" issueid="10101" module="ExampleApp.war"
                type="SQL Injection"
                description="The method buildOrderQuery() in ExampleOrderDao.java constructs a SQL query using the parameter 'searchTerm' which is derived from an HTTP request. The tainted data originated from earlier calls to javax.servlet.ServletRequest.getParameter. This call to java.sql.Statement.executeQuery() could allow an attacker to inject arbitrary SQL commands."
                cweid="89" remediationeffort="3" exploitLevel="2" categoryid="20"
                date_first_occurrence="2026-05-01T10:00:00.000-0000" remediation_status="New"
                sourcefile="ExampleOrderDao.java" line="88" sourcefilepath="com/example/webapp/dao/"
                scope="com.example.webapp.dao.ExampleOrderDao"
                functionprototype="ResultSet buildOrderQuery(java.lang.String)"
                functionrelativelocation="12" mitigation_status="none"/>
        </staticflaws>
      </cwe>
    </category>
  </severity>
  <severity level="4">
    <category categoryid="18" categoryname="Credentials Management" pcirelated="true">
      <desc><para text="Hard-coded credentials embedded in source code."/></desc>
      <recommendations>
        <para text="Store credentials in a secrets manager or environment configuration, never in source code."/>
      </recommendations>
      <cwe cweid="798" cwename="Use of Hard-coded Credentials" owasp="A07:2021-Identification and Authentication Failures">
        <description>
          <para text="Hard-coded credentials are a significant risk if the source code is disclosed."/>
        </description>
        <staticflaws>
          <flaw severity="4" categoryname="Credentials Management" count="1" issueid="10102" module="ExampleApp.war"
                type="Hard-coded Password"
                description="ExampleFtpClient.java contains a hard-coded password used to authenticate to an internal FTP host."
                cweid="798" remediationeffort="2" exploitLevel="3" categoryid="18"
                date_first_occurrence="2026-03-11T08:30:00.000-0000" remediation_status="Fixed"
                sourcefile="ExampleFtpClient.java" line="41" sourcefilepath="com/example/webapp/integration/"
                scope="com.example.webapp.integration.ExampleFtpClient"
                functionprototype="void connect()" functionrelativelocation="4" mitigation_status="none"/>
          <flaw severity="4" categoryname="Credentials Management" count="1" issueid="10103" module="ExampleApp.war"
                type="Hard-coded Password"
                description="A configuration loader embeds a hard-coded password used for an internal service account. No source file attribute was reported for this flaw by the scanner."
                cweid="798" remediationeffort="2" exploitLevel="3" categoryid="18"
                date_first_occurrence="2026-04-20T14:00:00.000-0000" remediation_status="Reopened"
                mitigation_status="none"/>
        </staticflaws>
      </cwe>
    </category>
  </severity>
</detailedreport>
```

- [ ] **Step 2: Create `src/test/fixtures/veracode/malformed-report.xml`** (truncated/invalid — error-path test)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<detailedreport report_format_version="1.5" app_name="ExampleApp">
  <severity level="5">
    <category categoryid="20" categoryname="SQL Injection"
```

- [ ] **Step 3: Create `src/test/fixtures/veracode/doctype-report.xml`** (XXE-guard test — must be rejected before parsing)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE detailedreport [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<detailedreport report_format_version="1.5" app_name="ExampleApp">
  <severity level="5"/>
</detailedreport>
```

- [ ] **Step 4: Write the failing test file `src/test/veracodeReport.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseVeracodeReport, filterFlaws, assertSafeVeracodeXml } from '../utils/veracodeReport';

const fixture = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', 'veracode', name), 'utf-8');

describe('parseVeracodeReport', () => {
  it('parses all static flaws with severity, CWE, and location data', () => {
    const flaws = parseVeracodeReport(fixture('sample-report.xml'));
    expect(flaws).toHaveLength(3);

    const sqlInjection = flaws.find(f => f.issueId === '10101')!;
    expect(sqlInjection.severity).toBe(5);
    expect(sqlInjection.categoryName).toBe('SQL Injection');
    expect(sqlInjection.cweId).toBe('89');
    expect(sqlInjection.cweName).toContain('SQL Injection');
    expect(sqlInjection.remediationStatus).toBe('New');
    expect(sqlInjection.sourceFile).toBe('ExampleOrderDao.java');
    expect(sqlInjection.sourceFilePath).toBe('com/example/webapp/dao/');
    expect(sqlInjection.line).toBe(88);
    expect(sqlInjection.recommendation).toContain('parameterized queries');
  });

  it('handles a flaw with no sourcefile/line/sourcefilepath (module fallback case)', () => {
    const flaws = parseVeracodeReport(fixture('sample-report.xml'));
    const missingSource = flaws.find(f => f.issueId === '10103')!;
    expect(missingSource.sourceFile).toBeNull();
    expect(missingSource.sourceFilePath).toBeNull();
    expect(missingSource.line).toBeNull();
    expect(missingSource.module).toBe('ExampleApp.war');
    expect(missingSource.remediationStatus).toBe('Reopened');
  });

  it('throws a clear error on malformed XML', () => {
    expect(() => parseVeracodeReport(fixture('malformed-report.xml'))).toThrow(/parse/i);
  });

  it('rejects a report containing a DOCTYPE/ENTITY declaration (XXE guard)', () => {
    expect(() => parseVeracodeReport(fixture('doctype-report.xml'))).toThrow(/DOCTYPE|ENTITY/i);
  });

  it('throws when the root <detailedreport> element is missing', () => {
    expect(() => parseVeracodeReport('<?xml version="1.0"?><notareport/>')).toThrow(/detailedreport/i);
  });

  it('skips a flaw with a non-numeric issueid (defense against JQL/label injection via a tampered report)', () => {
    const tampered = fixture('sample-report.xml').replace('issueid="10101"', 'issueid="10101) OR labels in (secret"');
    const flaws = parseVeracodeReport(tampered);
    expect(flaws.find(f => f.issueId.startsWith('10101'))).toBeUndefined();
    expect(flaws).toHaveLength(2); // the other two well-formed flaws in the fixture are still parsed
  });
});

describe('assertSafeVeracodeXml', () => {
  it('rejects input over the 20 MB size cap', () => {
    const huge = '<detailedreport>' + 'x'.repeat(21 * 1024 * 1024) + '</detailedreport>';
    expect(() => assertSafeVeracodeXml(huge)).toThrow(/size limit/i);
  });

  it('accepts a normal, small, well-formed document', () => {
    expect(() => assertSafeVeracodeXml(fixture('sample-report.xml'))).not.toThrow();
  });
});

describe('filterFlaws', () => {
  it('applies both the severity floor and the remediation-status allow-list (defaults)', () => {
    const flaws = parseVeracodeReport(fixture('sample-report.xml'));
    const filtered = filterFlaws(flaws, { minSeverity: 4, includeStatuses: ['New', 'Open', 'Reopened'] });
    // 10101 (New, sev 5) and 10103 (Reopened, sev 4) pass; 10102 (Fixed) is excluded
    expect(filtered.map(f => f.issueId).sort()).toEqual(['10101', '10103']);
  });

  it('excludes everything below minSeverity even if status matches', () => {
    const flaws = parseVeracodeReport(fixture('sample-report.xml'));
    const filtered = filterFlaws(flaws, { minSeverity: 6, includeStatuses: ['New', 'Open', 'Reopened'] });
    expect(filtered).toHaveLength(0);
  });

  it('status matching is case-insensitive', () => {
    const flaws = parseVeracodeReport(fixture('sample-report.xml'));
    const filtered = filterFlaws(flaws, { minSeverity: 0, includeStatuses: ['new', 'reopened'] });
    expect(filtered.map(f => f.issueId).sort()).toEqual(['10101', '10103']);
  });
});
```

Run it to confirm it fails (module doesn't exist yet):

```bash
npx vitest run src/test/veracodeReport.test.ts
```

Expected: fails with "Cannot find module '../utils/veracodeReport'".

- [ ] **Step 5: Implement `src/utils/veracodeReport.ts` (parsing + filtering portion)**

```ts
import { XMLParser } from 'fast-xml-parser';

export interface VeracodeFlaw {
  issueId: string;
  severity: number; // 0 (Informational) .. 5 (Very High)
  categoryName: string;
  cweId: string | null;
  cweName: string | null;
  description: string;
  recommendation: string | null;
  module: string;
  sourceFile: string | null;
  sourceFilePath: string | null;
  line: number | null;
  scope: string | null;
  functionPrototype: string | null;
  remediationStatus: string;
}

export const SEVERITY_LABELS = ['Informational', 'Very Low', 'Low', 'Medium', 'High', 'Very High'];

export function severityLabel(severity: number): string {
  return SEVERITY_LABELS[severity] ?? `Severity ${severity}`;
}

const MAX_REPORT_BYTES = 20 * 1024 * 1024; // 20 MB

// Defense-in-depth: fast-xml-parser does not resolve external entities, but we
// reject DOCTYPE/ENTITY declarations outright so a malicious file is never even parsed.
export function assertSafeVeracodeXml(raw: string): void {
  if (Buffer.byteLength(raw, 'utf8') > MAX_REPORT_BYTES) {
    throw new Error(`Veracode report exceeds the ${MAX_REPORT_BYTES / (1024 * 1024)} MB size limit.`);
  }
  if (/<!DOCTYPE/i.test(raw) || /<!ENTITY/i.test(raw)) {
    throw new Error('Veracode report contains a DOCTYPE/ENTITY declaration and was rejected for security reasons.');
  }
}

// Elements that may repeat but fast-xml-parser only arrays when count > 1 — force arrays always.
const ARRAY_TAGS = new Set(['severity', 'category', 'cwe', 'flaw', 'para']);

// issueid must be purely numeric — see the JQL-injection defense note in parseVeracodeReport below.
const ISSUE_ID_PATTERN = /^\d+$/;

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function extractRecommendation(recommendations: unknown): string | null {
  const recs = recommendations as { para?: Array<{ text?: string }> } | undefined;
  const paras = toArray(recs?.para).map(p => p.text).filter((t): t is string => Boolean(t));
  return paras.length > 0 ? paras.join('\n\n') : null;
}

export function parseVeracodeReport(xml: string): VeracodeFlaw[] {
  assertSafeVeracodeXml(xml);

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    isArray: (tagName: string) => ARRAY_TAGS.has(tagName),
  });

  let doc: Record<string, any>;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new Error(`Could not parse Veracode report XML: ${err instanceof Error ? err.message : String(err)}`);
  }

  const report = doc?.detailedreport;
  if (!report) {
    throw new Error('Not a recognizable Veracode Detailed Report (missing <detailedreport> root element).');
  }

  const flaws: VeracodeFlaw[] = [];
  for (const severity of toArray(report.severity)) {
    for (const category of toArray(severity.category)) {
      const recommendation = extractRecommendation(category.recommendations);
      for (const cwe of toArray(category.cwe)) {
        for (const flaw of toArray(cwe.staticflaws?.flaw)) {
          const issueId = String(flaw.issueid);
          // Defense-in-depth: issueId is interpolated directly into JQL later (`labels in (veracode-issue-<id>)`
          // in buildDedupJql, and `veracode-issue-<id>` as a label on the created ticket). Reject anything
          // non-numeric so a tampered/malformed report file can't smuggle a JQL/label injection.
          if (!ISSUE_ID_PATTERN.test(issueId)) {
            continue;
          }
          flaws.push({
            issueId,
            severity: Number(flaw.severity),
            categoryName: category.categoryname,
            cweId: cwe.cweid != null ? String(cwe.cweid) : null,
            cweName: cwe.cwename ?? null,
            description: flaw.description ?? '',
            recommendation,
            module: flaw.module,
            sourceFile: flaw.sourcefile ?? null,
            sourceFilePath: flaw.sourcefilepath ?? null,
            line: flaw.line != null ? Number(flaw.line) : null,
            scope: flaw.scope ?? null,
            functionPrototype: flaw.functionprototype ?? null,
            remediationStatus: flaw.remediation_status,
          });
        }
      }
    }
  }
  return flaws;
}

export interface VeracodeFilterOptions {
  minSeverity: number;
  includeStatuses: string[];
}

export function filterFlaws(flaws: VeracodeFlaw[], options: VeracodeFilterOptions): VeracodeFlaw[] {
  const statusSet = new Set(options.includeStatuses.map(s => s.toLowerCase()));
  return flaws.filter(f => f.severity >= options.minSeverity && statusSet.has(f.remediationStatus.toLowerCase()));
}
```

- [ ] **Step 6: Run tests, confirm green**

```bash
npx vitest run src/test/veracodeReport.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/utils/veracodeReport.ts src/test/veracodeReport.test.ts src/test/fixtures/veracode
git commit -m "feat: Veracode Detailed Report XML parsing + filtering (TDD)"
```

---

## Task 4: Content builders — short label, summary, description, labels (TDD)

Appended to the same pure module: `src/utils/veracodeReport.ts` / `src/test/veracodeReport.test.ts`.

- [ ] **Step 1: Add failing tests to `src/test/veracodeReport.test.ts`**

```ts
import { deriveShortLabel, buildSummary, buildDescriptionWiki, buildLabels } from '../utils/veracodeReport';

describe('deriveShortLabel', () => {
  it('extracts the quoted short name from the CWE name when present', () => {
    // Real MITRE CWE-89 name: "Improper Neutralization of Special Elements used in an SQL Command ('SQL Injection')"
    const label = deriveShortLabel(
      'SQL Injection',
      "Improper Neutralization of Special Elements used in an SQL Command ('SQL Injection')",
    );
    expect(label).toBe('SQL Injection');
  });

  it('falls back to categoryname when the CWE name has no quoted short form', () => {
    const label = deriveShortLabel('Credentials Management', 'Use of Hard-coded Credentials');
    expect(label).toBe('Credentials Management');
  });

  it('falls back to categoryname when cweName is null', () => {
    expect(deriveShortLabel('Improper Access Control', null)).toBe('Improper Access Control');
  });

  it('strips common stopwords but keeps up to 5 words when needed for meaningfulness', () => {
    const label = deriveShortLabel('Insufficient Session Expiration', "Insufficient Session Expiration (CWE ID 613)");
    // no quoted short-name in CWE, falls back to categoryname; no stopwords to strip here
    expect(label).toBe('Insufficient Session Expiration');
  });

  it('caps at 5 words for a long stopword-stripped category name', () => {
    const label = deriveShortLabel(
      'Improper Neutralization of Special Elements used in an Operating System Command',
      null,
    );
    expect(label.split(' ').length).toBeLessThanOrEqual(5);
  });
});

describe('buildSummary', () => {
  it('uses sourcefile + line when present', () => {
    const flaws = parseVeracodeReport(fixture('sample-report.xml'));
    const sqlInjection = flaws.find(f => f.issueId === '10101')!;
    expect(buildSummary(sqlInjection)).toBe('10101 - ExampleOrderDao.java:88 - SQL Injection');
  });

  it('falls back to module basename when sourcefile/line are absent', () => {
    const flaws = parseVeracodeReport(fixture('sample-report.xml'));
    const missingSource = flaws.find(f => f.issueId === '10103')!;
    expect(buildSummary(missingSource)).toBe('10103 - ExampleApp.war - Credentials Management');
  });
});

describe('buildDescriptionWiki', () => {
  it('renders all sections with a full location block', () => {
    const flaws = parseVeracodeReport(fixture('sample-report.xml'));
    const sqlInjection = flaws.find(f => f.issueId === '10101')!;
    const wiki = buildDescriptionWiki(sqlInjection);
    expect(wiki).toContain('h3. Severity\nVery High (5)');
    expect(wiki).toContain('[CWE-89|https://cwe.mitre.org/data/definitions/89.html]');
    expect(wiki).toContain('h3. Location\nModule: ExampleApp.war\nFile: com/example/webapp/dao/ExampleOrderDao.java:88\nFunction: ResultSet buildOrderQuery(java.lang.String)');
    expect(wiki).toContain('h3. Description\nThe method buildOrderQuery()');
    expect(wiki).toContain('h3. Recommendation\nUse parameterized queries');
    expect(wiki).toContain('h3. Veracode Issue ID\n10101');
  });

  it('omits File/Function lines and Recommendation section when data is absent', () => {
    const flaws = parseVeracodeReport(fixture('sample-report.xml'));
    const missingSource = flaws.find(f => f.issueId === '10103')!;
    const wiki = buildDescriptionWiki(missingSource);
    expect(wiki).toContain('h3. Location\nModule: ExampleApp.war');
    expect(wiki).not.toContain('File:');
    expect(wiki).not.toContain('Function:');
    // This flaw's CWE (798) does have a category-level recommendation in the fixture, so it IS present:
    expect(wiki).toContain('h3. Recommendation');
  });
});

describe('buildLabels', () => {
  it('always includes veracode, veracode-issue-<id>, and cwe-<id>', () => {
    const flaws = parseVeracodeReport(fixture('sample-report.xml'));
    const sqlInjection = flaws.find(f => f.issueId === '10101')!;
    expect(buildLabels(sqlInjection)).toEqual(['veracode', 'veracode-issue-10101', 'cwe-89']);
  });

  it('merges in template labels and de-duplicates', () => {
    const flaws = parseVeracodeReport(fixture('sample-report.xml'));
    const sqlInjection = flaws.find(f => f.issueId === '10101')!;
    const merged = buildLabels(sqlInjection, ['security', 'veracode']);
    expect(merged).toEqual(['veracode', 'veracode-issue-10101', 'cwe-89', 'security']);
  });
});
```

- [ ] **Step 2: Confirm the new tests fail** (functions don't exist yet), then implement.

- [ ] **Step 3: Append to `src/utils/veracodeReport.ts`**

```ts
const STOPWORDS = new Set(['of', 'a', 'an', 'the', 'or', 'and', 'used', 'in', 'to', 'for', 'on', 'using', 'via']);

// Prefers the CWE's own quoted short name (MITRE convention, e.g. "...('SQL Injection')"),
// falling back to the Veracode category name. Targets ~3 words, allows up to 5 for meaningfulness.
export function deriveShortLabel(categoryName: string, cweName: string | null): string {
  const quoted = cweName?.match(/'([^']+)'/)?.[1];
  const source = quoted ?? categoryName;
  const words = source.split(/\s+/).filter(Boolean);
  const filtered = words.filter(w => !STOPWORDS.has(w.toLowerCase()));
  const chosen = filtered.length > 0 ? filtered : words;
  return chosen.slice(0, 5).join(' ');
}

function fileRef(flaw: VeracodeFlaw): string {
  if (flaw.sourceFile) return flaw.sourceFile;
  const parts = flaw.module.split(/[\\/]/);
  return parts[parts.length - 1];
}

export function buildSummary(flaw: VeracodeFlaw): string {
  const ref = fileRef(flaw);
  const lineSuffix = flaw.line != null ? `:${flaw.line}` : '';
  const shortLabel = deriveShortLabel(flaw.categoryName, flaw.cweName);
  return `${flaw.issueId} - ${ref}${lineSuffix} - ${shortLabel}`;
}

function fullSourcePath(flaw: VeracodeFlaw): string | null {
  if (flaw.sourceFilePath && flaw.sourceFile) return `${flaw.sourceFilePath}${flaw.sourceFile}`;
  return flaw.sourceFile ?? null;
}

export function buildDescriptionWiki(flaw: VeracodeFlaw): string {
  const sections: string[] = [];

  sections.push(`h3. Severity\n${severityLabel(flaw.severity)} (${flaw.severity})`);

  if (flaw.cweId) {
    const link = `[CWE-${flaw.cweId}|https://cwe.mitre.org/data/definitions/${flaw.cweId}.html]`;
    sections.push(`h3. CWE\n${link}${flaw.cweName ? ` — ${flaw.cweName}` : ''}`);
  }

  const locationLines = [`Module: ${flaw.module}`];
  const path = fullSourcePath(flaw);
  if (path) locationLines.push(`File: ${path}${flaw.line != null ? `:${flaw.line}` : ''}`);
  if (flaw.functionPrototype) locationLines.push(`Function: ${flaw.functionPrototype}`);
  sections.push(`h3. Location\n${locationLines.join('\n')}`);

  sections.push(`h3. Description\n${flaw.description}`);

  if (flaw.recommendation) {
    sections.push(`h3. Recommendation\n${flaw.recommendation}`);
  }

  sections.push(`h3. Veracode Issue ID\n${flaw.issueId}`);

  return sections.join('\n\n');
}

export function buildLabels(flaw: VeracodeFlaw, templateLabels: string[] = []): string[] {
  const own = ['veracode', `veracode-issue-${flaw.issueId}`];
  if (flaw.cweId) own.push(`cwe-${flaw.cweId}`);
  return [...new Set([...own, ...templateLabels])];
}
```

- [ ] **Step 4: Run tests, confirm green; run full compile**

```bash
npx vitest run src/test/veracodeReport.test.ts && npm run compile
```

- [ ] **Step 5: Commit**

```bash
git add src/utils/veracodeReport.ts src/test/veracodeReport.test.ts
git commit -m "feat: Veracode ticket content builders (short label, summary, description, labels)"
```

### Worked example (fictitious data, for reference only)

For flaw `10101` from the fixture, with template `"Security Bug"` contributing `defaultFields.labels = ["security-review"]`:

- **Summary:** `10101 - ExampleOrderDao.java:88 - SQL Injection`
- **Labels:** `["veracode", "veracode-issue-10101", "cwe-89", "security-review"]`
- **Description (Jira wiki markup):**

```text
h3. Severity
Very High (5)

h3. CWE
[CWE-89|https://cwe.mitre.org/data/definitions/89.html] — Improper Neutralization of Special Elements used in an SQL Command ('SQL Injection')

h3. Location
Module: ExampleApp.war
File: com/example/webapp/dao/ExampleOrderDao.java:88
Function: ResultSet buildOrderQuery(java.lang.String)

h3. Description
The method buildOrderQuery() in ExampleOrderDao.java constructs a SQL query using the parameter 'searchTerm' which is derived from an HTTP request. The tainted data originated from earlier calls to javax.servlet.ServletRequest.getParameter. This call to java.sql.Statement.executeQuery() could allow an attacker to inject arbitrary SQL commands.

h3. Recommendation
Use parameterized queries or a properly configured ORM instead of building SQL from string concatenation.

Apply strict allow-list input validation to any values that must be interpolated.

h3. Veracode Issue ID
10101
```

---

## Task 5: De-duplication helpers (already-ticketed detection)

Appended to `src/utils/veracodeReport.ts` / `src/test/veracodeReport.test.ts`. These are pure — the handler (Task 7) supplies the search results from `TicketService.searchTicketsRaw`, already unchanged/existing.

- [ ] **Step 1: Add failing tests**

```ts
import { chunkIssueIds, buildDedupJql, extractDedupMap } from '../utils/veracodeReport';

describe('chunkIssueIds', () => {
  it('chunks into groups of 40 by default', () => {
    const ids = Array.from({ length: 85 }, (_, i) => String(i));
    const chunks = chunkIssueIds(ids);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(40);
    expect(chunks[2]).toHaveLength(5);
  });

  it('returns a single chunk when under the limit', () => {
    expect(chunkIssueIds(['1', '2', '3'])).toEqual([['1', '2', '3']]);
  });

  it('returns an empty array for no ids', () => {
    expect(chunkIssueIds([])).toEqual([]);
  });
});

describe('buildDedupJql', () => {
  it('builds a JQL clause matching veracode-issue-<id> labels for the project', () => {
    expect(buildDedupJql('PROJ', ['10101', '10103'])).toBe(
      'project = PROJ AND labels in (veracode-issue-10101, veracode-issue-10103)',
    );
  });
});

describe('extractDedupMap', () => {
  it('maps issueId -> ticket key from returned labels, ignoring unrelated labels', () => {
    const issues = [
      { key: 'PROJ-501', labels: ['veracode', 'veracode-issue-10101', 'cwe-89'] },
      { key: 'PROJ-502', labels: ['backend', 'veracode-issue-10103'] },
      { key: 'PROJ-503', labels: ['unrelated-ticket'] },
    ];
    const map = extractDedupMap(issues);
    expect(map.get('10101')).toBe('PROJ-501');
    expect(map.get('10103')).toBe('PROJ-502');
    expect(map.size).toBe(2);
  });

  it('returns an empty map when nothing matches', () => {
    expect(extractDedupMap([{ key: 'PROJ-1', labels: ['random'] }]).size).toBe(0);
  });
});
```

- [ ] **Step 2: Implement**

```ts
const DEDUP_CHUNK_SIZE = 40; // keeps generated JQL well under Jira's practical query-length limits

export function chunkIssueIds(issueIds: string[], chunkSize = DEDUP_CHUNK_SIZE): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < issueIds.length; i += chunkSize) {
    chunks.push(issueIds.slice(i, i + chunkSize));
  }
  return chunks;
}

export function buildDedupJql(projectKey: string, issueIds: string[]): string {
  const labels = issueIds.map(id => `veracode-issue-${id}`);
  return `project = ${projectKey} AND labels in (${labels.join(', ')})`;
}

export function extractDedupMap(issues: Array<{ key: string; labels: string[] }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const issue of issues) {
    for (const label of issue.labels) {
      const match = label.match(/^veracode-issue-(\d+)$/);
      if (match) map.set(match[1], issue.key);
    }
  }
  return map;
}
```

- [ ] **Step 3: Run tests, confirm green; commit**

```bash
npx vitest run src/test/veracodeReport.test.ts
git add src/utils/veracodeReport.ts src/test/veracodeReport.test.ts
git commit -m "feat: Veracode already-ticketed de-dup helpers"
```

**`veracodeReport.ts` is now complete and fully unit-tested in isolation — no `vscode` import anywhere in this file**, matching the `CLAUDE.md` testing convention ("Keep pure logic in files that can be unit-tested; VS Code-dependent glue code is covered by the e2e suite only").

---

## Task 6: Session types + review table/toggle parsing in `sessionState.ts` (TDD)

**Files:**
- Modify: `src/participant/sessionState.ts`
- Modify: `src/test/JiraParticipant.test.ts` (pure `sessionState.ts` helpers are tested here per existing convention)

- [ ] **Step 1: Add failing tests to `src/test/JiraParticipant.test.ts`**

Extend the existing import line:

```ts
import {
  extractCreatedKeyFromConfirmation, extractLastTicketFromText, isConfirmation, isCancellation, serializeTurns,
  stripHiddenMarkers, parseTemplateSelection, parseIssueTypeSelection, parseSkipInput, parseResolutionSelection,
  parseCommentIndex, buildCommentListSession, formatCommentsInFull, parseFilterSelection, parseBulkUpdateReview,
  rewriteAttachmentLinks, parseSkippedAttachmentSelection, pickEmailOption, buildTeamJql, selectDefaultIssueType,
  buildVeracodeReviewTable, parseVeracodeReviewInput, applyVeracodeToggle, type VeracodeReviewRow,
} from '../participant/sessionState';
```

Add new test blocks:

```ts
const sampleRows: VeracodeReviewRow[] = [
  {
    id: 'A1', issueId: '10102', severity: 4, severityLabelText: 'High', cweId: '798',
    summary: '10102 - ExampleFtpClient.java:41 - Credentials Management',
    labels: ['veracode', 'veracode-issue-10102', 'cwe-798'], descriptionWiki: 'h3. Severity\nHigh (4)',
    existingTicketKey: 'PROJ-501', included: false,
  },
  {
    id: '1', issueId: '10101', severity: 5, severityLabelText: 'Very High', cweId: '89',
    summary: '10101 - ExampleOrderDao.java:88 - SQL Injection',
    labels: ['veracode', 'veracode-issue-10101', 'cwe-89'], descriptionWiki: 'h3. Severity\nVery High (5)',
    existingTicketKey: null, included: true,
  },
  {
    id: '2', issueId: '10103', severity: 4, severityLabelText: 'High', cweId: '798',
    summary: '10103 - ExampleApp.war - Credentials Management',
    labels: ['veracode', 'veracode-issue-10103', 'cwe-798'], descriptionWiki: 'h3. Severity\nHigh (4)',
    existingTicketKey: null, included: true,
  },
];

describe('buildVeracodeReviewTable', () => {
  it('renders an "Already ticketed" section and a "New — will create" section', () => {
    const table = buildVeracodeReviewTable(sampleRows, 'https://jira.example.com');
    expect(table).toContain('### Already ticketed');
    expect(table).toContain('[PROJ-501](https://jira.example.com/browse/PROJ-501)');
    expect(table).toContain('### New — will create');
    expect(table).toContain('10101 - ExampleOrderDao.java:88 - SQL Injection');
    expect(table).toContain('**2** ticket(s) will be created.');
  });

  it('omits the "Already ticketed" section entirely when there are no dupes', () => {
    const onlyNew = sampleRows.filter(r => r.existingTicketKey === null);
    const table = buildVeracodeReviewTable(onlyNew);
    expect(table).not.toContain('Already ticketed');
  });

  it('renders plain ticket key (no link) when baseUrl is not provided', () => {
    const table = buildVeracodeReviewTable(sampleRows);
    expect(table).toContain('| A1 |');
    expect(table).toContain('PROJ-501');
    expect(table).not.toContain('](');
  });
});

describe('parseVeracodeReviewInput', () => {
  const ids = ['A1', '1', '2'];

  it('recognizes ok and cancel', () => {
    expect(parseVeracodeReviewInput('ok', ids)).toEqual({ action: 'ok' });
    expect(parseVeracodeReviewInput('c', ids)).toEqual({ action: 'cancel' });
    expect(parseVeracodeReviewInput('cancel', ids)).toEqual({ action: 'cancel' });
  });

  it('toggles a single new-row id (excludes a default-included row)', () => {
    expect(parseVeracodeReviewInput('2', ids)).toEqual({ action: 'toggle', ids: ['2'] });
  });

  it('toggles an already-ticketed row id (forces re-creation)', () => {
    expect(parseVeracodeReviewInput('A1', ids)).toEqual({ action: 'toggle', ids: ['A1'] });
  });

  it('toggles multiple ids at once, case-insensitively', () => {
    expect(parseVeracodeReviewInput('a1 2', ids)).toEqual({ action: 'toggle', ids: ['A1', '2'] });
  });

  it('returns invalid for unrecognized ids or empty input', () => {
    expect(parseVeracodeReviewInput('99', ids)).toEqual({ action: 'invalid' });
    expect(parseVeracodeReviewInput('', ids)).toEqual({ action: 'invalid' });
  });
});

describe('applyVeracodeToggle', () => {
  it('flips included for the given row ids and leaves the rest untouched', () => {
    const toggled = applyVeracodeToggle(sampleRows, ['2']);
    expect(toggled.find(r => r.id === '2')!.included).toBe(false);
    expect(toggled.find(r => r.id === '1')!.included).toBe(true);
  });

  it('flips an already-ticketed row back to included (force re-create)', () => {
    const toggled = applyVeracodeToggle(sampleRows, ['A1']);
    expect(toggled.find(r => r.id === 'A1')!.included).toBe(true);
  });

  it('toggles multiple ids at once', () => {
    const toggled = applyVeracodeToggle(sampleRows, ['1', '2']);
    expect(toggled.find(r => r.id === '1')!.included).toBe(false);
    expect(toggled.find(r => r.id === '2')!.included).toBe(false);
  });

  it('returns new row objects rather than mutating the input (pure function)', () => {
    const toggled = applyVeracodeToggle(sampleRows, ['1']);
    expect(toggled).not.toBe(sampleRows);
    expect(sampleRows.find(r => r.id === '1')!.included).toBe(true); // original array/objects untouched
  });
});
```

- [ ] **Step 2: Confirm the new tests fail**, then implement in `src/participant/sessionState.ts`.

- [ ] **Step 3: Add to `src/participant/sessionState.ts`**

```ts
import type { VeracodeFlaw } from '../utils/veracodeReport';

export interface VeracodeTemplateSelectionSession {
  reportFileName: string;
  projectKey: string;
  flaws: VeracodeFlaw[]; // already filtered by minSeverity/includeRemediationStatuses
  availableTemplates: Array<{ name: string; issueType: string }>;
  availableIssueTypes: string[];
}

export interface VeracodeReviewRow {
  id: string;                    // '1'..'N' new candidates, 'A1'..'Am' already-ticketed
  issueId: string;
  severity: number;
  severityLabelText: string;
  cweId: string | null;
  summary: string;
  labels: string[];
  descriptionWiki: string;
  existingTicketKey: string | null;
  included: boolean;             // whether this row will be (re)created if the batch runs
}

export interface VeracodeReviewSession {
  projectKey: string;
  issueType: string;
  templateName: string | null;
  additionalFields: Record<string, unknown>; // resolved template fields (labels merged in per-row already)
  rows: VeracodeReviewRow[];
}

export function buildVeracodeReviewTable(rows: VeracodeReviewRow[], baseUrl?: string): string {
  const ticketed = rows.filter(r => r.existingTicketKey !== null);
  const fresh = rows.filter(r => r.existingTicketKey === null);
  const lines: string[] = [];

  if (ticketed.length > 0) {
    lines.push('### Already ticketed');
    lines.push('| # | Severity | CWE | Flaw | Ticket | Include? |');
    lines.push('|---|----------|-----|------|--------|----------|');
    for (const r of ticketed) {
      const ticketRef = baseUrl ? `[${r.existingTicketKey}](${baseUrl}/browse/${r.existingTicketKey})` : r.existingTicketKey;
      lines.push(`| ${r.id} | ${r.severityLabelText} (${r.severity}) | ${r.cweId ? `CWE-${r.cweId}` : '—'} | ${r.summary} | ${ticketRef} | ${r.included ? '✓ re-create' : '_excluded_'} |`);
    }
    lines.push('');
  }

  lines.push('### New — will create');
  lines.push('| # | Severity | CWE | Summary | Include? |');
  lines.push('|---|----------|-----|---------|----------|');
  for (const r of fresh) {
    lines.push(`| ${r.id} | ${r.severityLabelText} (${r.severity}) | ${r.cweId ? `CWE-${r.cweId}` : '—'} | ${r.summary} | ${r.included ? '✓' : '_excluded_'} |`);
  }

  const willCreate = rows.filter(r => r.included).length;
  lines.push('');
  lines.push(`**${willCreate}** ticket(s) will be created.`);
  lines.push('');
  lines.push('Reply **ok** to proceed, **(c)** to cancel, or a list of ids to toggle (e.g. `2 4` or `A1`).');

  return lines.join('\n');
}

export type VeracodeReviewParseResult =
  | { action: 'ok' }
  | { action: 'cancel' }
  | { action: 'toggle'; ids: string[] }
  | { action: 'invalid' };

export function parseVeracodeReviewInput(reply: string, rowIds: string[]): VeracodeReviewParseResult {
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

// Pure so it's independently testable — the vscode-dependent handler (Task 7) just calls this and
// re-streams the result, rather than mutating VeracodeReviewRow objects in place.
export function applyVeracodeToggle(rows: VeracodeReviewRow[], ids: string[]): VeracodeReviewRow[] {
  const toggleSet = new Set(ids);
  return rows.map(r => (toggleSet.has(r.id) ? { ...r, included: !r.included } : r));
}
```

- [ ] **Step 4: Run tests, confirm green; run full compile**

```bash
npx vitest run src/test/JiraParticipant.test.ts && npm run compile
```

- [ ] **Step 5: Commit**

```bash
git add src/participant/sessionState.ts src/test/JiraParticipant.test.ts
git commit -m "feat: Veracode review session types + table/toggle helpers"
```

---

## Task 7: Chat glue — `src/participant/jira/veracodeHandler.ts`

This file is **not** unit-testable in isolation (imports `vscode`), matching the existing convention for `emailHandler.ts` / `cleanupHandler.ts` — its correctness relies on the already-tested pure functions from `veracodeReport.ts` / `sessionState.ts` plus a manual smoke test (Task 11).

- [ ] **Step 1: Add one more pure, testable helper to `src/utils/veracodeReport.ts`** — bucketing filtered flaws into review rows given a de-dup map is pure (no `vscode`), so it lives here, not in the handler:

```ts
import type { VeracodeReviewRow } from '../participant/sessionState'; // type-only, no cycle risk (sessionState does not import veracodeReport's functions)

export function buildReviewRows(
  flaws: VeracodeFlaw[],
  dedupMap: Map<string, string>,
  templateLabels: string[] = [],
): VeracodeReviewRow[] {
  const rows: VeracodeReviewRow[] = [];
  let newIndex = 0;
  let ticketedIndex = 0;
  for (const flaw of flaws) {
    const existingTicketKey = dedupMap.get(flaw.issueId) ?? null;
    rows.push({
      id: existingTicketKey ? `A${++ticketedIndex}` : `${++newIndex}`,
      issueId: flaw.issueId,
      severity: flaw.severity,
      severityLabelText: severityLabel(flaw.severity),
      cweId: flaw.cweId,
      summary: buildSummary(flaw),
      labels: buildLabels(flaw, templateLabels),
      descriptionWiki: buildDescriptionWiki(flaw),
      existingTicketKey,
      included: existingTicketKey === null,
    });
  }
  return rows;
}
```

> Note: `sessionState.ts` will end up importing `VeracodeFlaw` (type-only) from `veracodeReport.ts`, and `veracodeReport.ts` imports `VeracodeReviewRow` (type-only) from `sessionState.ts`. This is a type-only circular import, which TypeScript handles fine (it's erased at compile time) — **if you'd rather avoid it entirely**, move the `VeracodeReviewRow` interface into `veracodeReport.ts` instead and re-export/import it from `sessionState.ts`. Either is acceptable; pick whichever keeps your editor's "go to definition" experience cleanest. This plan assumes the interface stays in `sessionState.ts` since all other session types live there.

Add matching test to `src/test/veracodeReport.test.ts`:

```ts
import { buildReviewRows } from '../utils/veracodeReport';

describe('buildReviewRows', () => {
  it('assigns sequential numeric ids to new flaws and A-prefixed ids to already-ticketed ones, in flaw order', () => {
    const flaws = parseVeracodeReport(fixture('sample-report.xml'));
    const dedupMap = new Map([['10102', 'PROJ-501']]); // note: 10102 is the "Fixed" flaw, filtered out upstream in practice —
                                                        // here we test buildReviewRows in isolation with all 3 fixture flaws
    const rows = buildReviewRows(flaws, dedupMap, ['security-review']);
    expect(rows.find(r => r.issueId === '10102')).toMatchObject({ id: 'A1', included: false, existingTicketKey: 'PROJ-501' });
    expect(rows.find(r => r.issueId === '10101')).toMatchObject({ id: '1', included: true, existingTicketKey: null });
    expect(rows.find(r => r.issueId === '10103')).toMatchObject({ id: '2', included: true, existingTicketKey: null });
    expect(rows.find(r => r.issueId === '10101')!.labels).toContain('security-review');
  });
});
```

- [ ] **Step 2: Run tests, confirm green; commit**

```bash
npx vitest run src/test/veracodeReport.test.ts
git add src/utils/veracodeReport.ts src/test/veracodeReport.test.ts
git commit -m "feat: buildReviewRows (pure row-bucketing for the review screen)"
```

- [ ] **Step 3: Create `src/participant/jira/veracodeHandler.ts`**

```ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TicketService } from '../../services/TicketService';
import type { IJiraClient } from '../../jira/IJiraClient';
import { TemplateService } from '../../templates/TemplateService';
import { FieldResolver } from '../../templates/FieldResolver';
import {
  parseVeracodeReport, filterFlaws, chunkIssueIds, buildDedupJql, extractDedupMap, buildReviewRows,
  type VeracodeFlaw,
} from '../../utils/veracodeReport';
import type { VeracodeTemplateSelectionSession, VeracodeReviewSession } from '../sessionState';
import {
  isCancellation, pickEmailOption, buildVeracodeReviewTable, parseVeracodeReviewInput, applyVeracodeToggle,
  extractCreatedKeyFromConfirmation,
} from '../sessionState';
import { resolveProjectKey } from './ticketContext';

const MAX_REPORT_BYTES = 20 * 1024 * 1024; // 20 MB
const BATCH_LIMIT = 50; // matches the cleanupHandler.ts BATCH_LIMIT convention — not user-configurable

function getVeracodeConfig(): { minSeverity: number; includeStatuses: string[] } {
  const cfg = vscode.workspace.getConfiguration('ticketSidekick');
  return {
    minSeverity: cfg.get<number>('veracode.minSeverity') ?? 4,
    includeStatuses: cfg.get<string[]>('veracode.includeRemediationStatuses') ?? ['New', 'Open', 'Reopened'],
  };
}

async function readAndFilterVeracodeFile(filePath: string): Promise<VeracodeFlaw[]> {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_REPORT_BYTES) {
    throw new Error(`File exceeds the ${MAX_REPORT_BYTES / (1024 * 1024)} MB size limit.`);
  }
  const raw = await fs.promises.readFile(filePath, 'utf-8');
  // parseVeracodeReport() itself also re-checks size + rejects DOCTYPE/ENTITY (defense in depth,
  // and it's the single source of truth used by the pure unit tests too).
  const flaws = parseVeracodeReport(raw);
  return filterFlaws(flaws, getVeracodeConfig());
}

// Chat-only entry point's own file picker — mirrors emailHandler.ts's openEmailFilePicker.
async function openVeracodeFilePicker(
  stream: vscode.ChatResponseStream,
): Promise<{ flaws: VeracodeFlaw[]; fileName: string } | null> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'Veracode report': ['xml'] },
    defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads')),
    title: 'Select Veracode Detailed Report (.xml)',
  });
  if (!uris || uris.length === 0) return null;

  try {
    const flaws = await readAndFilterVeracodeFile(uris[0].fsPath);
    return { flaws, fileName: uris[0].fsPath.split(/[\\/]/).pop() ?? uris[0].fsPath };
  } catch (err) {
    stream.markdown(`_Could not import report: ${err instanceof Error ? err.message : String(err)}_`);
    return null;
  }
}

export async function buildVeracodeTemplateSession(
  flaws: VeracodeFlaw[],
  fileName: string,
  projectKey: string,
  jiraClient: IJiraClient,
): Promise<VeracodeTemplateSelectionSession> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const availableTemplates: Array<{ name: string; issueType: string }> = (() => {
    if (!workspaceRoot) return [];
    try {
      return new TemplateService(workspaceRoot).loadTemplates().templates
        .map(t => ({ name: t.name, issueType: t.issueType ?? 'Bug' }));
    } catch { return []; }
  })();

  let issueTypes: string[] = [];
  try {
    const project = await jiraClient.getProject(projectKey);
    issueTypes = project.issueTypes.filter(t => !t.subtask).map(t => t.name);
  } catch { /* fall through to the 'Bug' default below */ }

  return {
    reportFileName: fileName,
    projectKey,
    flaws,
    availableTemplates,
    availableIssueTypes: issueTypes.length > 0 ? issueTypes : ['Bug'],
  };
}

export async function streamVeracodeTemplateSelection(
  session: VeracodeTemplateSelectionSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<void> {
  await ws.update('jira.session.veracodeTemplateSelection', session);
  const { availableTemplates: templates, availableIssueTypes: issueTypes } = session;

  let optionsList = '';
  if (templates.length > 0) {
    optionsList += `**Templates:**\n${templates.map((t, i) => `${i + 1}. ${t.name} _(${t.issueType})_`).join('\n')}\n\n`;
  }
  const offset = templates.length;
  optionsList += `**Issue types (no template):**\n${issueTypes.map((t, i) => `${offset + i + 1}. ${t}`).join('\n')}\n\n`;

  stream.markdown(
    `Found **${session.flaws.length}** flaw(s) in \`${session.reportFileName}\` matching your severity/status filters ` +
    `for project **${session.projectKey}**.\n\n${optionsList}` +
    `Reply with a number to select a template or issue type, or **(c)** to cancel.\n\n<!-- jira:veracode-template -->`,
  );
}

// Entry point for the "importVeracode" operation. Handles both invocation paths:
//  1. Command-triggered — a VeracodeTemplateSelectionSession is already in workspaceState (built by extension.ts).
//  2. Chat-only ("@jira import veracode report" with no prior command) — opens its own file picker.
// projectKeyHint comes from the LLM-parsed intent.projectKey (e.g. "@jira import veracode report for PROJ");
// resolveProjectKey() falls back to the defaultProject setting, then an input box, when it's null.
export async function handleImportVeracodeReport(
  _request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
  jiraClient: IJiraClient,
  _ticketService: TicketService,
  ws: vscode.Memento,
  projectKeyHint: string | null = null,
): Promise<void> {
  const existing = ws.get<VeracodeTemplateSelectionSession>('jira.session.veracodeTemplateSelection');
  if (existing) {
    await streamVeracodeTemplateSelection(existing, stream, ws);
    return;
  }

  const picked = await openVeracodeFilePicker(stream);
  if (!picked) return;
  if (picked.flaws.length === 0) {
    stream.markdown(
      'No flaws in this report matched your current filters ' +
      '(`ticketSidekick.veracode.minSeverity` / `ticketSidekick.veracode.includeRemediationStatuses`).',
    );
    return;
  }

  const projectKey = await resolveProjectKey(projectKeyHint, stream);
  if (!projectKey) {
    stream.markdown('_No project key provided — cancelled._');
    return;
  }

  const session = await buildVeracodeTemplateSession(picked.flaws, picked.fileName, projectKey, jiraClient);
  await streamVeracodeTemplateSelection(session, stream, ws);
}

async function findAlreadyTicketed(
  ticketService: TicketService,
  projectKey: string,
  issueIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const chunk of chunkIssueIds(issueIds)) {
    if (chunk.length === 0) continue;
    const jql = buildDedupJql(projectKey, chunk);
    const result = await ticketService.searchTicketsRaw(jql, 100);
    const found = extractDedupMap(result.issues.map(i => ({ key: i.key, labels: i.fields.labels })));
    for (const [id, key] of found) map.set(id, key);
  }
  return map;
}

export async function handleVeracodeTemplateSelection(
  reply: string,
  session: VeracodeTemplateSelectionSession,
  jiraClient: IJiraClient,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<void> {
  if (isCancellation(reply)) {
    await ws.update('jira.session.veracodeTemplateSelection', undefined);
    stream.markdown('_Cancelled — no tickets were created._');
    return;
  }

  const n = parseInt(reply.trim(), 10);
  const pick = isNaN(n) ? null : pickEmailOption(n, session.availableTemplates, session.availableIssueTypes);
  if (!pick) {
    stream.markdown(`Didn't understand that reply.\n\n`);
    await streamVeracodeTemplateSelection(session, stream, ws);
    return;
  }
  await ws.update('jira.session.veracodeTemplateSelection', undefined);

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
        stream.markdown(
          `_Warning: could not resolve template fields — proceeding without them: ` +
          `${err instanceof Error ? err.message : String(err)}_\n\n`,
        );
      }
    }
  }

  stream.markdown(`_Checking for already-ticketed flaws…_\n\n`);
  const templateLabels = Array.isArray(additionalFields.labels) ? additionalFields.labels as string[] : [];
  const dedupMap = await findAlreadyTicketed(ticketService, session.projectKey, session.flaws.map(f => f.issueId));
  const rows = buildReviewRows(session.flaws, dedupMap, templateLabels);

  const reviewSession: VeracodeReviewSession = {
    projectKey: session.projectKey,
    issueType: pick.issueType,
    templateName,
    additionalFields,
    rows,
  };
  await streamVeracodeReview(reviewSession, stream, ws, baseUrl);
}

export async function streamVeracodeReview(
  session: VeracodeReviewSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<void> {
  await ws.update('jira.session.veracodeReview', session);
  stream.markdown(`${buildVeracodeReviewTable(session.rows, baseUrl)}\n\n<!-- jira:veracode-review -->`);
}

export async function handleVeracodeReviewReply(
  reply: string,
  session: VeracodeReviewSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<void> {
  const rowIds = session.rows.map(r => r.id);
  const decision = parseVeracodeReviewInput(reply, rowIds);

  if (decision.action === 'invalid') {
    stream.markdown(
      `Didn't understand that. Reply **ok** to proceed, **(c)** to cancel, ` +
      `or a list of ids to toggle (e.g. \`2 4\` or \`A1\`).\n\n<!-- jira:veracode-review -->`,
    );
    return;
  }
  if (decision.action === 'cancel') {
    await ws.update('jira.session.veracodeReview', undefined);
    stream.markdown('_Cancelled — no tickets were created._');
    return;
  }
  if (decision.action === 'toggle') {
    session.rows = applyVeracodeToggle(session.rows, decision.ids);
    await streamVeracodeReview(session, stream, ws, baseUrl);
    return;
  }

  // decision.action === 'ok'
  await ws.update('jira.session.veracodeReview', undefined);
  await executeVeracodeBatch(session, ticketService, stream);
}

export async function executeVeracodeBatch(
  session: VeracodeReviewSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
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
      stream.markdown(`✓ ${key ?? '?'} — ${row.summary}\n\n`);
      created++;
    } catch (err) {
      stream.markdown(`✗ Flaw ${row.issueId} — ${err instanceof Error ? err.message : String(err)}\n\n`);
      failed++;
    }
  }

  const total = session.rows.length;
  let summary =
    `${total} flaw(s) reviewed — **${created}** created, ${failed} failed, ` +
    `${excludedByUser} excluded by you, ${alreadyTicketedSkipped} already ticketed (skipped).`;
  if (session.rows.length > BATCH_LIMIT) {
    summary += `\n\n_Batch capped at ${BATCH_LIMIT} tickets per run — re-run the import to process the remainder._`;
  }
  stream.markdown(summary);
}
```

- [ ] **Step 4: Compile check**

```bash
npm run compile
```

Expected: no errors. (This file has no dedicated unit test — it's pure glue over already-tested functions, matching `emailHandler.ts`/`cleanupHandler.ts` convention. `npm run test:e2e` currently has no source under `src/test/` for the existing e2e suite either — `test:e2e` runs a pre-compiled `out/test/runTest.js` from historical tooling not present in this checkout, so there is nothing to add there for this feature. Rely on the unit-test coverage in Tasks 3–6 plus the manual smoke test in Task 11.)

- [ ] **Step 5: Commit**

```bash
git add src/participant/jira/veracodeHandler.ts
git commit -m "feat: Veracode chat handler (template selection, review, batch create)"
```

---

## Task 8: Routing — `llmHelpers.ts` Operation + `JiraParticipant.ts` dispatch

**Files:**
- Modify: `src/participant/jira/llmHelpers.ts`
- Modify: `src/participant/JiraParticipant.ts`

- [ ] **Step 1: Add the new operation to the `Operation` union in `llmHelpers.ts`**

```ts
export type Operation =
  | 'getTicket'
  | 'summarizeTicket'
  | 'showComments'
  | 'getComments'
  | 'addComment'
  | 'updateField'
  | 'showFields'
  | 'searchJql'
  | 'validateFields'
  | 'createTicket'
  | 'discoverWorkflow'
  | 'runCleanup'
  | 'transition'
  | 'bulkTransition'
  | 'bulkUpdateField'
  | 'loadTicket'
  | 'spellCheck'
  | 'createFromEmail'
  | 'addEmailComment'
  | 'importVeracode';
```

- [ ] **Step 2: Add `"importVeracode"` to the `INTENT_PROMPT` schema literal and add a description bullet**

In the schema line, extend the operation enum:

```text
Schema: {"operation":"getTicket"|...|"createFromEmail"|"addEmailComment"|"importVeracode","ticketKey":string|null,...}
```

Add a new bullet directly after the `addEmailComment` bullet:

```text
- importVeracode: import a Veracode Detailed Report XML export and create Jira tickets from its flaws; triggered by "import veracode", "import veracode report", "veracode report", "create tickets from veracode", "veracode scan"; only use this when the session is already loaded via command palette, or to trigger the chat's own file picker if no command was used; projectKey is extracted from the prompt the same as for createTicket when the user names a project (e.g. "import veracode report for PROJ"), otherwise left null so the handler falls back to the default-project setting or an input box
```

- [ ] **Step 3: Update `JiraParticipant.ts` imports**

```ts
import {
  handleImportVeracodeReport, handleVeracodeTemplateSelection, handleVeracodeReviewReply,
} from './jira/veracodeHandler';
import type { VeracodeTemplateSelectionSession, VeracodeReviewSession } from './sessionState';
```

- [ ] **Step 4: Add two session-detection blocks**, placed directly after the existing "Email content session" block (same file, same `if (lastResponse.includes(...))` early-return pattern):

```ts
// Veracode template/issue-type selection
if (lastResponse.includes('<!-- jira:veracode-template -->')) {
  const templateSession = ws.get<VeracodeTemplateSelectionSession>('jira.session.veracodeTemplateSelection');
  if (templateSession) {
    await handleVeracodeTemplateSelection(request.prompt, templateSession, jiraClient, ticketService, stream, ws, config.baseUrl);
    return;
  }
}

// Veracode flaw review / selection screen
if (lastResponse.includes('<!-- jira:veracode-review -->')) {
  const reviewSession = ws.get<VeracodeReviewSession>('jira.session.veracodeReview');
  if (reviewSession) {
    await handleVeracodeReviewReply(request.prompt, reviewSession, ticketService, stream, ws, config.baseUrl);
    return;
  }
}
```

- [ ] **Step 5: Add operation dispatch**, alongside the existing `createFromEmail`/`addEmailComment` blocks (before the generic `ticketKey` resolution branch, since this operation needs neither):

```ts
if (intent.operation === 'importVeracode') {
  await handleImportVeracodeReport(request, stream, token, jiraClient, ticketService, ws, intent.projectKey);
  return;
}
```

- [ ] **Step 6: Compile + run full unit suite**

```bash
npm run compile && npm test
```

- [ ] **Step 7: Commit**

```bash
git add src/participant/jira/llmHelpers.ts src/participant/JiraParticipant.ts
git commit -m "feat: route importVeracode operation + session detection"
```

---

## Task 9: VS Code command registration — `src/extension.ts`

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Add imports**

```ts
import { parseVeracodeReport, filterFlaws } from './utils/veracodeReport';
import type { VeracodeTemplateSelectionSession } from './participant/sessionState';
```

- [ ] **Step 2: Add the command**, alongside the existing `ticket-sidekick.importEml` registration:

```ts
vscode.commands.registerCommand('ticket-sidekick.importVeracodeReport', async () => {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'Veracode report': ['xml'] },
    defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads')),
    title: 'Select Veracode Detailed Report (.xml)',
  });
  if (!uris || uris.length === 0) return;
  const reportPath = uris[0].fsPath;

  const MAX_REPORT_BYTES = 20 * 1024 * 1024;
  let raw: string;
  try {
    const stat = await fs.promises.stat(reportPath);
    if (stat.size > MAX_REPORT_BYTES) {
      vscode.window.showErrorMessage(`Ticket Sidekick: Report exceeds the ${MAX_REPORT_BYTES / (1024 * 1024)} MB size limit.`);
      return;
    }
    raw = await fs.promises.readFile(reportPath, 'utf-8');
  } catch (err) {
    vscode.window.showErrorMessage(`Ticket Sidekick: Could not read file: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const veracodeCfg = vscode.workspace.getConfiguration('ticketSidekick');
  let flaws;
  try {
    const allFlaws = parseVeracodeReport(raw);
    flaws = filterFlaws(allFlaws, {
      minSeverity: veracodeCfg.get<number>('veracode.minSeverity') ?? 4,
      includeStatuses: veracodeCfg.get<string[]>('veracode.includeRemediationStatuses') ?? ['New', 'Open', 'Reopened'],
    });
  } catch (err) {
    vscode.window.showErrorMessage(`Ticket Sidekick: Could not parse Veracode report: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (flaws.length === 0) {
    vscode.window.showInformationMessage(
      'Ticket Sidekick: No flaws in this report matched your current severity/status filters ' +
      '(ticketSidekick.veracode.minSeverity / ticketSidekick.veracode.includeRemediationStatuses).',
    );
    return;
  }

  const config = await configService.getConfig();
  if (!config.baseUrl || !config.token) {
    vscode.window.showErrorMessage('Ticket Sidekick: Configure Jira credentials first.');
    return;
  }

  let projectKey = veracodeCfg.get<string>('jira.defaultProject') ?? '';
  if (!projectKey) {
    const entered = await vscode.window.showInputBox({
      prompt: 'Enter the Jira project key for the new tickets (e.g. PROJ)',
      placeHolder: 'PROJECT',
      ignoreFocusOut: true,
    });
    if (!entered) return;
    projectKey = entered;
  }

  const jiraClient = new JiraApiClient({ baseUrl: config.baseUrl, authType: config.authType, token: config.token });
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

  const availableTemplates: Array<{ name: string; issueType: string }> = (() => {
    if (!workspaceRoot) return [];
    try {
      return new TemplateService(workspaceRoot).loadTemplates().templates
        .map(t => ({ name: t.name, issueType: t.issueType ?? 'Bug' }));
    } catch { return []; }
  })();

  const issueTypes = await jiraClient.getProject(projectKey)
    .then(p => p.issueTypes.filter(t => !t.subtask).map(t => t.name))
    .catch((err: unknown) => {
      vscode.window.showWarningMessage(
        `Ticket Sidekick: Could not fetch issue types for ${projectKey} — will default to 'Bug'. ${err instanceof Error ? err.message : String(err)}`,
      );
      return [] as string[];
    });

  const session: VeracodeTemplateSelectionSession = {
    reportFileName: path.basename(reportPath),
    projectKey,
    flaws,
    availableTemplates,
    availableIssueTypes: issueTypes.length > 0 ? issueTypes : ['Bug'],
  };

  await context.workspaceState.update('jira.session.veracodeTemplateSelection', session);
  await vscode.commands.executeCommand('workbench.action.chat.open', { query: '@jira import veracode report' });
}),
```

- [ ] **Step 3: Add the command entry to `package.json` `contributes.commands`** (already done in Task 2 — verify it's present).

- [ ] **Step 4: Compile + smoke-check command registration**

```bash
npm run compile
```

Then in the Extension Development Host: Command Palette → "Ticket Sidekick: Create Jira tickets from Veracode report (.xml)" should appear.

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts
git commit -m "feat: register ticket-sidekick.importVeracodeReport command"
```

---

## Task 10: Documentation updates

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: `README.md`** — add a new subsection under `## @jira — Jira`, right after the existing `### Create Jira ticket from email (.eml)` section, following the same style:

```markdown
### Create Jira tickets from a Veracode report (.xml)

Export a Detailed Report XML from Veracode, then:

1. Run **Command Palette → Ticket Sidekick: Create Jira tickets from Veracode report (.xml)**
2. Select the `.xml` file
3. Pick a template or issue type in the `@jira` chat
4. Review the flaw list — already-ticketed flaws are shown separately and excluded by default; reply with row numbers to toggle inclusion/exclusion, or **ok** to proceed
5. Tickets are created one per flaw, with severity, CWE (linked to the public CWE definition), file/line location, the flaw's own description, and the category's remediation recommendation

You can also trigger the import from the chat directly:

```text
@jira import veracode report
```

A file picker opens, and you proceed as above.

Each ticket is labeled `veracode`, `veracode-issue-<id>`, and `cwe-<id>` (plus any labels from your chosen template), so re-running the import after a partial run — or after remediating some flaws and re-scanning — will not create duplicate tickets for flaws that already have one.

**Settings:**

| Setting | Default | Description |
|---|---|---|
| `ticketSidekick.veracode.minSeverity` | `4` | Minimum severity (0–5) included by default |
| `ticketSidekick.veracode.includeRemediationStatuses` | `["New", "Open", "Reopened"]` | Remediation statuses included by default |

Only `<staticflaws>` are imported (dynamic/manual analysis findings are out of scope). A batch creates at most 50 tickets per run — re-run the import to process the remainder of a larger report.
```

- [ ] **Step 1b: Add a row to the existing "Core commands" table** (around line 56, in the same `| What you type | What happens |` table that already lists `@jira create from email`):

```markdown
| `@jira import veracode report` | Create Jira tickets from a Veracode Detailed Report XML export |
```

- [ ] **Step 1c: Add rows to the existing consolidated "Settings reference" table** (around line 605 — the single table near the end of the `@jira` section that already lists `ticketSidekick.email.deleteEmlAfterImport`; this is separate from the inline mini-table added in Step 1 above, which only documents the setting locally within the new subsection):

```markdown
| Veracode min severity | `ticketSidekick.veracode.minSeverity` | `4` |
| Veracode included statuses | `ticketSidekick.veracode.includeRemediationStatuses` | `["New", "Open", "Reopened"]` |
```

- [ ] **Step 2: `CLAUDE.md`** — three small, targeted edits:

**(a)** Add two rows to the "Key files" table, alphabetically near the other Jira participant rows:

```markdown
| `src/utils/veracodeReport.ts` | Veracode Detailed Report XML parsing, filtering, short-label/summary/description/label builders, and de-dup helpers — pure, no `vscode` import |
| `src/participant/jira/veracodeHandler.ts` | Veracode import chat flow: template selection, already-ticketed de-dup + review screen, batch ticket creation |
```

**(b)** Add a row to the "Multi-turn session state" → "Jira sessions" table:

```markdown
| `VeracodeTemplateSelectionSession` | `jira.session.veracodeTemplateSelection` | `<!-- jira:veracode-template -->` |
| `VeracodeReviewSession` | `jira.session.veracodeReview` | `<!-- jira:veracode-review -->` |
```

And extend the detection-order sentence:

```markdown
Detection order in the Jira handler: resolution selection → transition review → filter selection → bulk-update-review → template selection → issue type selection → creation → content → more-comments → check command → load-skipped → email content → veracode template selection → veracode review → comment list → intent parse.
```

**(c)** Add a new `## Veracode report import` section (mirroring the existing `## EML email import` section):

```markdown
## Veracode report import

Users export a Detailed Report XML from Veracode and import it via the VS Code command or directly from chat (`@jira import veracode report`).

### Import flow

1. Command Palette → **Ticket Sidekick: Create Jira tickets from Veracode report (.xml)** (or trigger from chat, which opens its own file picker)
2. `parseVeracodeReport(xml)` (own parser, `fast-xml-parser`-based) extracts all `<staticflaws>` entries; rejected up front if the file exceeds 20 MB or contains a `<!DOCTYPE`/`<!ENTITY` declaration
3. `filterFlaws()` applies `ticketSidekick.veracode.minSeverity` and `ticketSidekick.veracode.includeRemediationStatuses`
4. `VeracodeTemplateSelectionSession` stored in `workspaceState('jira.session.veracodeTemplateSelection')`; chat opened with `@jira import veracode report`
5. User picks a template or issue type (`pickEmailOption()`, reused from the email flow) → `FieldResolver.resolve()` resolves the template's fields
6. De-dup search: `TicketService.searchTicketsRaw` is called in chunks of 40 issue ids with a `labels in (veracode-issue-<id>, ...)` JQL clause; matches become the "Already ticketed" section of the review screen (excluded by default, toggleable back in)
7. `VeracodeReviewSession` stored in `workspaceState('jira.session.veracodeReview')`; user replies **ok** / **(c)** / a list of row ids to toggle inclusion
8. On **ok**, up to 50 tickets are created via the existing `TicketService.createTicket` — one per included flaw, each labeled `veracode`, `veracode-issue-<id>`, `cwe-<id>` (merged with any template labels) with a wiki-markup description (Severity, CWE + link, Location, Description, Recommendation, Veracode Issue ID)

### Known limitation

The multi-step vulnerability data-path trace shown in Veracode's web UI ("Injection Point → ... → Flaw") is **not present** in the Detailed Report XML format — confirmed by full XSD schema review and empirical inspection of a real report. Only the flaw's own `description` attribute (which sometimes names generic tainted-source APIs, but not the actual call chain) is available and is included verbatim in the ticket. Full data-path support would require a different Veracode API/export (e.g. the Findings REST API) and is out of scope for this feature.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document Veracode report import feature"
```

---

## Task 11: Worked examples, final verification, and scope recap

### Worked example — review screen (fictitious data)

Using the fixture from Task 3, assuming flaw `10103` was already ticketed as `PROJ-777` in an earlier run:

```markdown
### Already ticketed
| # | Severity | CWE | Flaw | Ticket | Include? |
|---|----------|-----|------|--------|----------|
| A1 | High (4) | CWE-798 | 10103 - ExampleApp.war - Credentials Management | [PROJ-777](https://jira.example.com/browse/PROJ-777) | _excluded_ |

### New — will create
| # | Severity | CWE | Summary | Include? |
|---|----------|-----|---------|----------|
| 1 | Very High (5) | CWE-89 | 10101 - ExampleOrderDao.java:88 - SQL Injection | ✓ |

**1** ticket(s) will be created.

Reply **ok** to proceed, **(c)** to cancel, or a list of ids to toggle (e.g. `2 4` or `A1`).
```

If the user replies `A1`, row `A1` flips to `✓ re-create` and the "will create" count becomes 2. If they then reply `ok`, both are created.

### Worked example — batch creation result

```markdown
_Creating 2 ticket(s)…_

✓ PROJ-812 — 10101 - ExampleOrderDao.java:88 - SQL Injection

✓ PROJ-813 — 10103 - ExampleApp.war - Credentials Management

2 flaw(s) reviewed — **2** created, 0 failed, 0 excluded by you, 0 already ticketed (skipped).
```

(Or, had the user left `A1` excluded and only confirmed the one new flaw: `2 flaw(s) reviewed — **1** created, 0 failed, 0 excluded by you, 1 already ticketed (skipped).`)

The full rendered description for a created ticket (flaw `10101`) is shown in the Task 4 worked example above — summary, labels, and the complete wiki-markup body.

### Final verification checklist

- [ ] `npm run compile` — clean, no TypeScript errors
- [ ] `npm test` — all Vitest suites green, including the new `veracodeReport.test.ts` and the additions to `JiraParticipant.test.ts`
- [ ] Manual smoke test in the Extension Development Host (`F5`), against a **sandbox/test Jira project only**:
  1. Command Palette → **Ticket Sidekick: Create Jira tickets from Veracode report (.xml)** → select a small real or synthetic report
  2. Confirm the flaw count and project shown match expectations; pick a template (or "no template" issue type)
  3. Confirm the "Already ticketed" section is empty on a first run, and the "New — will create" section lists every filtered flaw with a sensible summary
  4. Toggle one row off, confirm the "will create" count decrements and the table re-renders correctly
  5. Reply `ok`; confirm one Jira ticket per included flaw is created, with correct summary, labels (`veracode`, `veracode-issue-<id>`, `cwe-<id>`), and a well-formatted description (headings render correctly in the Jira UI)
  6. Re-run the same import against the same report; confirm every flaw now appears in "Already ticketed" and is excluded by default (no duplicates created)
  7. Try `@jira import veracode report` directly from chat with no prior command — confirm the file picker opens and the same flow completes
  8. Try importing a non-Veracode / malformed XML file — confirm a clear error message, no crash
- [ ] Confirm `docs/review-process.md`-style parity is **not** required here (that doc is Bitbucket-specific); no new docs file needed beyond the `README.md`/`CLAUDE.md` edits in Task 10, per the "don't create markdown files unless requested" convention — this plan document itself is the only new markdown file

### Explicitly out of scope (confirmed with user)

- **Multi-step vulnerability data-path/call-stack trace** (Veracode UI's "Injection Point → ... → Flaw"). Confirmed absent from the Detailed Report XML schema and from a real report's raw data (full XSD element inventory + direct empirical check against a real flaw record). Only the flaw's own free-text `description` (which may name generic tainted-source APIs but not the real call chain or line numbers) is available and is included verbatim. **Decision: proceed without it for now; revisit only if a different Veracode export/API (e.g. the Findings REST API) is later integrated, with a real sample of that response shape to design against.**
- `dynamicflaws` and `manualflaws` — only `<staticflaws>` are imported.
- Attaching the raw XML report or any call-stack breakdown to the created tickets.
- A configurable batch cap — hardcoded at 50 tickets/run, matching the `BATCH_LIMIT` convention in `cleanupHandler.ts`.
- Any changes to `IJiraClient`, `JiraApiClient`, or `MockJiraClient` — the existing `createTicket`/`searchTicketsRaw` methods are sufficient as-is.
- Any changes to Bitbucket code or the `@bitbucket` participant.
