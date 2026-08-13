import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseWaltzReport, assertSafeWaltzReportSize, filterComponents,
  buildSummary, buildDescriptionWiki, buildLabels, sanitizeComponentLabel,
  buildReviewRows,
  type WaltzComponent,
} from '../utils/waltzReport';

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

  it('collapses duplicate ComponentRemediations rows for the same component into a single result', async () => {
    const components = await parseWaltzReport(fixtureBuffer('duplicate-component-report.xlsx'));
    const matches = components.filter(c => c.nameVersion === 'example-dup:1.0.0');
    expect(matches).toHaveLength(1);
    expect(matches[0].instancePaths).toEqual(['/app/services/checkout/package-lock.json']);
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
    // Same expected set as the "applies both...(defaults)" test above — only the casing differs here.
    expect(filtered.map(c => c.nameVersion).sort()).toEqual([
      'example-http:3.3.3', 'example-io:4.5.0', 'example-lib:1.2.3',
    ]);
  });
});

describe('sanitizeComponentLabel', () => {
  it('lowercases, replaces disallowed separators with hyphens (dots pass through, e.g. for version numbers), prefixes oss-dep-, and appends a disambiguating hash', () => {
    const label = sanitizeComponentLabel('Example.Lib:1.2.3');
    // ':' is not in the allowed [a-z0-9._-] set and becomes '-'; '.' is allowed and stays literal
    // (keeps version numbers like "1.2.3" readable instead of turning them into "1-2-3").
    expect(label).toMatch(/^oss-dep-example\.lib-1\.2\.3-[0-9a-f]{6}$/);
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

  it('neutralizes markdown-structural characters in untrusted cell content so a crafted CVE summary cannot inject a heading, table row, link, bold/italic text, or strikethrough', () => {
    const malicious: WaltzComponent = {
      nameVersion: 'example-evil:1.0.0',
      maxVulnRating: 'High',
      remediationAction: null,
      instancePaths: [],
      vulnerabilities: [{
        cveId: 'CVE-2099-9999',
        cveSummary: 'Injected\n# Fake Heading\n| a | b |\n[click me](http://evil.example) *bold* ~~struck~~',
        overallSeverity: 'High',
        cvssV3Score: 9,
        fixedVersion: null,
      }],
    };
    const wiki = buildDescriptionWiki(malicious);
    // The embedded newlines must not create new lines the converter re-parses as structure.
    expect(wiki).not.toContain('h1. Fake Heading');
    expect(wiki).not.toContain('||a||b||');
    // Brackets are stripped, so the link syntax never forms.
    expect(wiki).not.toContain('[click me|http://evil.example]');
    // Asterisks are stripped, so no bold/italic markup forms either.
    expect(wiki).not.toContain('*bold*');
    // Tildes are stripped, so markdownToJiraWiki()'s strikethrough regex (/~~(.+?)~~/g) never
    // matches and the value can't render as struck-through (Jira wiki strikethrough is `-text-`).
    expect(wiki).not.toContain('~~struck~~');
    expect(wiki).not.toContain('-struck-');
  });

  it('prefixes a standalone-line value (Max Vuln Rating, Component) with ": " so a crafted value cannot become an ordered-list item, a horizontal rule, a blockquote, or a heading', () => {
    // Each value below is chosen to actually trigger the named line-start rule in
    // markdownToJiraWiki() when it appears unprefixed at the start of a line — see
    // docs/solutions/security-issues/waltz-oss-report-markdown-injection-in-jira-wiki-converter.md.
    const cases: Array<{ value: string; unwantedMarkup: string }> = [
      { value: '1. urgent', unwantedMarkup: '# urgent' }, // ordered list -> Jira '# ' marker
      { value: '---', unwantedMarkup: '----' }, // horizontal rule -> Jira '----'
      { value: '> quoted', unwantedMarkup: '{quote}' }, // blockquote -> Jira {quote} block
      { value: '# fake heading', unwantedMarkup: 'h1. fake heading' }, // heading -> Jira 'hN. '
    ];
    for (const { value, unwantedMarkup } of cases) {
      const component: WaltzComponent = {
        nameVersion: value,
        maxVulnRating: value,
        remediationAction: null,
        instancePaths: [],
        vulnerabilities: [],
      };
      const wiki = buildDescriptionWiki(component);
      expect(wiki).not.toContain(unwantedMarkup);
      // The prefixed, sanitized value is still present verbatim, just not at line-start.
      expect(wiki).toContain(`: ${value}`);
    }
  });

  it('replaces a literal pipe in a table-cell value so it cannot split the Known vulnerabilities table row', () => {
    const withPipe: WaltzComponent = {
      nameVersion: 'example-pipe:1.0.0',
      maxVulnRating: 'High',
      remediationAction: null,
      instancePaths: [],
      vulnerabilities: [{
        cveId: 'CVE-2099-0001',
        cveSummary: null,
        overallSeverity: 'High | Critical',
        cvssV3Score: 7,
        fixedVersion: null,
      }],
    };
    const wiki = buildDescriptionWiki(withPipe);
    expect(wiki).toContain('|CVE-2099-0001|High / Critical|7|n/a|');
  });
});

// chunkComponentLabels/buildDedupJql/extractDedupMap are now thin delegates to the shared
// chunkStrings/buildDedupJql/extractDedupMap primitives in reportImport.ts — see
// reportImport.test.ts for their tests.

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
