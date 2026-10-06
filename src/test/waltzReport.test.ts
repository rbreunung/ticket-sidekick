import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseWaltzReport, assertSafeWaltzReportSize, filterComponents,
  buildSummary, buildDescriptionWiki, buildLabels, sanitizeComponentLabel,
  buildCveLabel, buildRatingLabel, buildRecordLabels, parseRecordLabels, describeWaltzChange, describeWaltzRowChange,
  buildUpdateCommentWiki, buildFollowUpDescriptionWiki, buildFollowUpSummary, rewriteSummaryRating,
  buildGroupSummary, buildGroupLabels, buildGroupDescriptionWiki, buildFoldedCommentWiki,
  type WaltzComponent,
} from '../utils/waltzReport';
import { sanitizeCellText } from '../utils/reportImport';

const fixturePath = (name: string) => join(__dirname, 'fixtures', 'waltz', name);
const fixtureBuffer = (name: string) => readFileSync(fixturePath(name));

function makeComponent(nameVersion: string, maxVulnRating: string, cveIds: string[], summaryFor: (id: string) => string | null = () => null): WaltzComponent {
  return {
    nameVersion,
    maxVulnRating,
    remediationAction: null,
    instancePaths: ['/app/services/checkout/pom.xml'],
    vulnerabilities: cveIds.map((cveId, i) => ({
      cveId, cveSummary: summaryFor(cveId), overallSeverity: i === 0 ? 'High' : 'Critical', cvssV3Score: 7 + i, fixedVersion: null,
    })),
  };
}

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

  it('accepts a buffer over the default 20 MB cap when given a larger custom maxBytes', () => {
    const twentyFiveMb = Buffer.alloc(25 * 1024 * 1024);
    expect(() => assertSafeWaltzReportSize(twentyFiveMb)).toThrow(/size limit/i);
    expect(() => assertSafeWaltzReportSize(twentyFiveMb, 50 * 1024 * 1024)).not.toThrow();
  });

  it('rejects a buffer over a custom maxBytes, reporting that custom limit in the message', () => {
    expect(() => assertSafeWaltzReportSize(Buffer.alloc(10 * 1024 * 1024), 5 * 1024 * 1024)).toThrow(/5 MB size limit/);
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
    expect(buildLabels(exampleLib)).toEqual([
      'oss-dependency', sanitizeComponentLabel(exampleLib.nameVersion),
      'oss-cve-cve-2099-0001', 'oss-cve-cve-2099-0002', 'oss-rating-critical',
    ]);
  });

  it('records a CVE-2021-44228 / Critical component as oss-cve-cve-2021-44228 + oss-rating-critical alongside the component labels (KTD4)', () => {
    const log4j = makeComponent('log4j-core 2.14.1', 'Critical', ['CVE-2021-44228']);
    expect(buildLabels(log4j)).toEqual([
      'oss-dependency', sanitizeComponentLabel('log4j-core 2.14.1'), 'oss-cve-cve-2021-44228', 'oss-rating-critical',
    ]);
  });

  it('merges in template labels without duplicates', async () => {
    const components = await parseWaltzReport(fixtureBuffer('sample-report.xlsx'));
    const exampleLib = components.find(c => c.nameVersion === 'example-lib:1.2.3')!;
    expect(buildLabels(exampleLib, ['oss-dependency', 'team-payments'])).toEqual([
      'oss-dependency', sanitizeComponentLabel(exampleLib.nameVersion),
      'oss-cve-cve-2099-0001', 'oss-cve-cve-2099-0002', 'oss-rating-critical', 'team-payments',
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
    // CVE ids are untrusted, externally-sourced text and go through sanitizeCellText() like any
    // other cell value — dashes are stripped along with the other Jira-native trigger chars
    // (Finding #1), so ids/paths render without them.
    expect(wiki).toContain(`*${sanitizeCellText('CVE-2099-0001')}* — Improper input validation may allow remote code execution via crafted deserialization payloads.`);
    expect(wiki).toContain('h3. Affected artifacts (1 total)');
    expect(wiki).toContain(sanitizeCellText('/app/services/checkout/package-lock.json'));
    expect(wiki).toContain('h3. Known vulnerabilities (2 total');
    // Known vulnerabilities renders as a real Jira wiki table (built from a Markdown table via markdownToJiraWiki()).
    expect(wiki).toContain('||CVE||Severity||CVSS||Fixed Version||');
    expect(wiki).toContain(`|${sanitizeCellText('CVE-2099-0001')}|Critical|9.8|1.2.4|`);
    expect(wiki).toContain(`|${sanitizeCellText('CVE-2099-0002')}|High|7.5|1.2.4|`);
    expect(wiki.indexOf(sanitizeCellText('CVE-2099-0001'))).toBeLessThan(wiki.indexOf(sanitizeCellText('CVE-2099-0002'))); // higher CVSS first
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
    expect(wiki).toContain(`*${sanitizeCellText('CVE-2099-0099')}* — No summary reported.`);
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
    // cveId is untrusted, externally-sourced text and goes through sanitizeCellText() like any
    // other cell value — its dashes are stripped along with the other Jira-native trigger chars
    // (Finding #1), so the id itself renders without them.
    expect(wiki).toContain(`*${sanitizeCellText('CVE-2099-0000')}* — Fictitious summary for issue 0.`); // lowest cveId wins tie-break, is "most critical"
    expect(wiki).toContain(`|${sanitizeCellText('CVE-2099-0000')}|High|7|n/a|`); // same row also appears in the Known vulnerabilities table
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
    // Instance paths are untrusted and go through sanitizeCellText(), which now also strips '-'
    // (Finding #1), so a real-world hyphenated path (e.g. "package-lock.json") loses its dashes too.
    expect(wiki).toContain(sanitizeCellText('/app/services/svc-0/package-lock.json'));
    expect(wiki).not.toContain(sanitizeCellText('/app/services/svc-29/package-lock.json'));
  });

  it('neutralizes markdown-structural characters in untrusted cell content so a crafted CVE summary cannot inject a heading, table row, link, bold/italic text, or strikethrough', () => {
    const malicious: WaltzComponent = {
      nameVersion: 'example-evil:1.0.0',
      maxVulnRating: 'High',
      remediationAction: null,
      instancePaths: [],
      vulnerabilities: [{
        cveId: 'CVE-2099-9999',
        cveSummary: 'Injected\n# Fake Heading\n| a | b |\n[click me](http://evil.example) *bold* ~~struck~~'
          + '\n-struck- +underline+ ^super^ ??cite?? {quote}FAKE{quote} !http://evil.example/t.gif!',
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
    // Jira-native trigger characters the converter itself never touches (Finding #1) — underline,
    // superscript, citation, macros, and the remote-image-embed tracking-pixel exploit.
    expect(wiki).not.toContain('+underline+');
    expect(wiki).not.toContain('^super^');
    expect(wiki).not.toContain('??cite??');
    expect(wiki).not.toContain('{quote}FAKE{quote}');
    expect(wiki).not.toContain('!http://evil.example/t.gif!');
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
      // The prefixed value is still present, sanitized the same way sanitizeCellText() sanitizes
      // any other cell value (e.g. '---' is now entirely consumed since '-' is a stripped
      // Jira-native trigger character too — see Finding #1).
      expect(wiki).toContain(`: ${sanitizeCellText(value)}`);
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
    expect(wiki).toContain(`|${sanitizeCellText('CVE-2099-0001')}|High / Critical|7|n/a|`);
  });
});

// chunkComponentLabels/buildDedupJql/extractDedupMap/buildReviewRows were Waltz-local wrappers
// around the shared primitives in reportImport.ts; they've been removed now that waltzHandler.ts
// calls those shared primitives directly — see reportImport.test.ts for their tests.

describe('Waltz record labels', () => {
  it('builds lower-cased, sanitized CVE and rating labels', () => {
    expect(buildCveLabel('CVE-2021-44228')).toBe('oss-cve-cve-2021-44228');
    expect(buildCveLabel('GHSA xxxx:yyyy')).toBe('oss-cve-ghsa-xxxx-yyyy');
    expect(buildRatingLabel('Critical')).toBe('oss-rating-critical');
  });

  it('keeps an overlong id within the label length limit', () => {
    expect(buildCveLabel('X'.repeat(400)).length).toBeLessThanOrEqual(250);
  });

  it('records each CVE once plus exactly one rating label', () => {
    const c = makeComponent('pkg 1.0', 'High', ['CVE-1', 'cve-1', 'CVE-2']);
    expect(buildRecordLabels(c)).toEqual(['oss-cve-cve-1', 'oss-cve-cve-2', 'oss-rating-high']);
  });

  it('reads CVE ids and the highest recorded rating back from a label list', () => {
    const parsed = parseRecordLabels([
      'oss-dependency', 'oss-dep-x-abc123', 'oss-cve-cve-2021-44228', 'oss-rating-medium', 'oss-rating-high', 'team-a',
    ]);
    expect(parsed.cveIds).toEqual(['cve-2021-44228']);
    expect(parsed.rating).toBe('High');
  });

  it('reports no record when only component labels are present', () => {
    expect(parseRecordLabels(['oss-dependency', 'oss-dep-x-abc123'])).toEqual({ cveIds: [], rating: null });
  });
});

describe('describeWaltzChange', () => {
  const componentLabel = sanitizeComponentLabel('jackson-databind 2.9');

  it('finds new CVEs and a rating rise against the known labels', () => {
    const c = makeComponent('jackson-databind 2.9', 'Critical', ['CVE-A', 'CVE-B']);
    const change = describeWaltzChange(c, ['oss-dependency', componentLabel, buildCveLabel('CVE-A'), 'oss-rating-high']);
    expect(change).toEqual({ newCveIds: ['CVE-B'], ratingRise: { from: 'High', to: 'Critical' } });
  });

  it('reports a baseline when the tickets carry no CVE or rating labels (pre-existing ticket)', () => {
    const c = makeComponent('jackson-databind 2.9', 'Critical', ['CVE-A', 'CVE-B']);
    expect(describeWaltzChange(c, ['oss-dependency', componentLabel])).toEqual({ baseline: true });
  });

  it('returns null when every CVE is known and the rating is unchanged', () => {
    const c = makeComponent('jackson-databind 2.9', 'High', ['CVE-A', 'CVE-B']);
    expect(describeWaltzChange(c, [componentLabel, buildCveLabel('CVE-A'), buildCveLabel('CVE-B'), 'oss-rating-high'])).toBeNull();
  });

  it('does not treat a rating drop as a change', () => {
    const c = makeComponent('jackson-databind 2.9', 'High', ['CVE-A']);
    expect(describeWaltzChange(c, [componentLabel, buildCveLabel('CVE-A'), 'oss-rating-critical'])).toBeNull();
  });

  it('compares against the highest rating when several tickets record different ratings', () => {
    const c = makeComponent('jackson-databind 2.9', 'Critical', ['CVE-A']);
    expect(describeWaltzChange(c, [buildCveLabel('CVE-A'), 'oss-rating-high', 'oss-rating-critical'])).toBeNull();
  });

  it('reports only new CVEs when the rating is unchanged', () => {
    const c = makeComponent('jackson-databind 2.9', 'High', ['CVE-A', 'CVE-C']);
    expect(describeWaltzChange(c, [buildCveLabel('CVE-A'), 'oss-rating-high'])).toEqual({ newCveIds: ['CVE-C'] });
  });
});

describe('rewriteSummaryRating', () => {
  it('replaces the trailing imported rating (AE4)', () => {
    expect(rewriteSummaryRating('[OSS] log4j-core 2.14.1 — High', 'Critical')).toBe('[OSS] log4j-core 2.14.1 — Critical');
  });

  it('leaves a renamed summary alone (AE4)', () => {
    expect(rewriteSummaryRating('log4j upgrade', 'Critical')).toBeNull();
  });

  it('keeps a trailing follow-up suffix', () => {
    expect(rewriteSummaryRating('[OSS] jackson-databind 2.9 — High (follow-up to PROJ-8)', 'Critical'))
      .toBe('[OSS] jackson-databind 2.9 — Critical (follow-up to PROJ-8)');
  });

  it('replaces whatever known rating ends the summary, even one below the rise\'s from (#6)', () => {
    // T1 still says Low while a resolved follow-up recorded Medium; the report now says High.
    expect(rewriteSummaryRating('[OSS] x — Low', 'High')).toBe('[OSS] x — High');
  });

  it('replaces a lower known rating in front of a follow-up suffix (#6)', () => {
    expect(rewriteSummaryRating('[OSS] x — Low (follow-up to PROJ-8)', 'High'))
      .toBe('[OSS] x — High (follow-up to PROJ-8)');
  });

  it('matches the known rating case-insensitively', () => {
    expect(rewriteSummaryRating('[OSS] x — medium', 'Critical')).toBe('[OSS] x — Critical');
  });

  it('accepts the two-argument form without a from rating', () => {
    expect(rewriteSummaryRating('[OSS] x — Low', 'High')).toBe('[OSS] x — High');
    expect(rewriteSummaryRating('log4j upgrade', 'High')).toBeNull();
  });

  it('returns null when the summary ends in an unknown word after the dash', () => {
    expect(rewriteSummaryRating('[OSS] x — Urgent', 'Critical')).toBeNull();
  });
});

describe('buildFollowUpSummary', () => {
  it('appends the follow-up suffix to the standard summary', () => {
    const c = makeComponent('jackson-databind 2.9', 'Critical', ['CVE-A']);
    expect(buildFollowUpSummary(c, 'PROJ-8')).toBe('[OSS] jackson-databind 2.9 — Critical (follow-up to PROJ-8)');
  });
});

describe('buildUpdateCommentWiki', () => {
  const c = makeComponent('log4j-core 2.14.1', 'Critical', ['CVE-A', 'CVE-B'], id => `Summary of ${id}`);

  it('lists only the new CVEs with severity, score and summary, plus the rating rise', () => {
    const wiki = buildUpdateCommentWiki(c, { newCveIds: ['CVE-B'], ratingRise: { from: 'High', to: 'Critical' } });
    expect(wiki).toContain(sanitizeCellText('CVE-B'));
    expect(wiki).toContain('Summary of CVEB');
    expect(wiki).toContain('|Critical|8|');
    expect(wiki).not.toContain(`|${sanitizeCellText('CVE-A')}|`);
    expect(wiki).toMatch(/High → Critical/);
    expect(wiki).not.toMatch(/summary was not changed/i);
  });

  it('notes when the summary was left unchanged', () => {
    const wiki = buildUpdateCommentWiki(c, { newCveIds: [], ratingRise: { from: 'High', to: 'Critical' } }, { summaryUnchanged: true });
    expect(wiki).toMatch(/summary was not changed/i);
    expect(wiki).not.toContain('||CVE||');
  });
});

describe('buildFollowUpDescriptionWiki', () => {
  it('describes only the new CVEs', () => {
    const c = makeComponent('jackson-databind 2.9', 'Critical', ['CVE-A', 'CVE-B', 'CVE-C']);
    const wiki = buildFollowUpDescriptionWiki(c, ['CVE-C']);
    expect(wiki).toContain('h3. Known vulnerabilities (1 total)');
    expect(wiki).toContain(sanitizeCellText('CVE-C'));
    expect(wiki).not.toContain(`|${sanitizeCellText('CVE-A')}|`);
    expect(wiki).not.toContain(`|${sanitizeCellText('CVE-B')}|`);
  });
});

describe('update comment and follow-up description neutralize crafted CVE summaries', () => {
  const evil = makeComponent('evil 1.0', 'Critical', ['CVE-X'], () => 'Pwn {code}alert(1){code}\nh1. Fake heading\n| a | b |');

  for (const [name, build] of [
    ['update comment', () => buildUpdateCommentWiki(evil, { newCveIds: ['CVE-X'] })],
    ['follow-up description', () => buildFollowUpDescriptionWiki(evil, ['CVE-X'])],
  ] as const) {
    it(`in the ${name}`, () => {
      const wiki = build();
      expect(wiki).not.toContain('{code}');
      expect(wiki).not.toMatch(/^h1\. Fake/m);
      expect(wiki).not.toContain('||a||b||');
    });
  }
});

// U3: adapter from describeWaltzChange's result to the shared RowChange shape buildReviewRows uses.
describe('describeWaltzRowChange', () => {
  const componentLabel = sanitizeComponentLabel('jackson-databind 2.9');

  it('maps a baseline to { kind: baseline }', () => {
    const c = makeComponent('jackson-databind 2.9', 'High', ['CVE-A']);
    expect(describeWaltzRowChange(c, [componentLabel])).toEqual({ kind: 'baseline' });
  });

  it('maps new CVEs and a rating rise to a findings change', () => {
    const c = makeComponent('jackson-databind 2.9', 'Critical', ['CVE-A', 'CVE-B']);
    expect(describeWaltzRowChange(c, [componentLabel, buildCveLabel('CVE-A'), 'oss-rating-high'])).toEqual({
      kind: 'findings', newIds: ['CVE-B'], ratingRise: { from: 'High', to: 'Critical' },
    });
  });

  it('maps a rating-only rise to a findings change with no new ids', () => {
    const c = makeComponent('jackson-databind 2.9', 'Critical', ['CVE-A']);
    expect(describeWaltzRowChange(c, [componentLabel, buildCveLabel('CVE-A'), 'oss-rating-high'])).toEqual({
      kind: 'findings', newIds: [], ratingRise: { from: 'High', to: 'Critical' },
    });
  });

  it('returns null when nothing changed', () => {
    const c = makeComponent('jackson-databind 2.9', 'High', ['CVE-A']);
    expect(describeWaltzRowChange(c, [componentLabel, buildCveLabel('CVE-A'), 'oss-rating-high'])).toBeNull();
  });
});

describe('Waltz folded groups (R1, R3, R8-R11)', () => {
  const netty = (artifact: string, version: string, rating: string, cves: string[] = ['CVE-2099-1']) =>
    makeComponent(`${artifact}:${version}`, rating, cves);

  describe('a one-component group is unchanged from the unfolded layout', () => {
    const c = makeComponent('example-lib:1.2.3', 'Critical', ['CVE-2099-0001', 'CVE-2099-0002']);

    it('has the same title, labels and description as the single-component builders', () => {
      expect(buildGroupSummary([c])).toBe(buildSummary(c));
      expect(buildGroupLabels([c], ['security'])).toEqual(buildLabels(c, ['security']));
      expect(buildGroupDescriptionWiki([c])).toBe(buildDescriptionWiki(c));
    });
  });

  describe('title', () => {
    it('AE5: names the first component, counts the others, and ends with the highest rating', () => {
      const group = [netty('netty-codec', '4.1.100', 'High'), netty('netty-handler', '4.1.100', 'High'), netty('netty-buffer', '4.1.94', 'Medium')];
      expect(buildGroupSummary(group)).toBe('[OSS] netty-codec:4.1.100 +2 components — High');
    });

    it('uses the highest rating of mixed ratings', () => {
      const group = [netty('a', '1', 'Medium'), netty('b', '1', 'High'), netty('c', '1', 'Critical')];
      expect(buildGroupSummary(group)).toBe('[OSS] a:1 +2 components — Critical');
    });

    it('still ends in " — <rating>" so a rating-rise update can rewrite it', () => {
      const group = [netty('a', '1', 'Medium'), netty('b', '1', 'High')];
      expect(rewriteSummaryRating(buildGroupSummary(group), 'Critical')).toBe('[OSS] a:1 +1 component — Critical');
    });

    it('trims a very long component name to 255 characters and keeps the count and rating', () => {
      const group = [netty('x'.repeat(300), '1', 'High'), netty('b', '1', 'High')];
      const summary = buildGroupSummary(group);
      expect(summary.length).toBeLessThanOrEqual(255);
      expect(summary.endsWith(' +1 component — High')).toBe(true);
    });
  });

  describe('labels (R11)', () => {
    it('AE5: carries every member component label, every CVE label, one rating label, and oss-dependency', () => {
      const group = [
        netty('netty-codec', '4.1.100', 'High', ['CVE-2099-1', 'CVE-2099-2']),
        netty('netty-handler', '4.1.100', 'Medium', ['CVE-2099-2', 'CVE-2099-3']),
      ];
      const labels = buildGroupLabels(group, ['security']);
      expect(labels).toContain('oss-dependency');
      expect(labels).toContain(sanitizeComponentLabel('netty-codec:4.1.100'));
      expect(labels).toContain(sanitizeComponentLabel('netty-handler:4.1.100'));
      expect(labels.filter(l => l.startsWith('oss-cve-')).sort()).toEqual(['oss-cve-cve-2099-1', 'oss-cve-cve-2099-2', 'oss-cve-cve-2099-3']);
      expect(labels.filter(l => l.startsWith('oss-rating-'))).toEqual(['oss-rating-high']);
      expect(labels).toContain('security');
    });
  });

  describe('description (R8)', () => {
    const group = [
      makeComponent('netty-codec:4.1.100', 'High', ['CVE-2099-1', 'CVE-2099-2']),
      makeComponent('netty-handler:4.1.94', 'Critical', ['CVE-2099-3']),
    ];

    it('opens with a banner stating how many components it folds', () => {
      expect(buildGroupDescriptionWiki(group).startsWith('This ticket folds 2 components from the OSS report.')).toBe(true);
    });

    it('has an overview table with component, rating, CVE count and artifact count, one row per component', () => {
      const wiki = buildGroupDescriptionWiki(group);
      expect(wiki).toContain('||Component||Max rating||CVEs||Artifacts||');
      // The table cell goes through sanitizeCellText() like every report value (it drops hyphens).
      expect(wiki).toContain(`|${sanitizeCellText('netty-codec:4.1.100')}|High|2|1|`);
      expect(wiki).toContain(`|${sanitizeCellText('netty-handler:4.1.94')}|Critical|1|1|`);
    });

    it('gives each component its own section with its vulnerabilities', () => {
      const wiki = buildGroupDescriptionWiki(group);
      expect(wiki).toContain(`h3. Component ${sanitizeCellText('netty-codec:4.1.100')}`);
      expect(wiki).toContain(`h3. Component ${sanitizeCellText('netty-handler:4.1.94')}`);
      expect(wiki).toContain(sanitizeCellText('CVE-2099-3'));
    });

    it('cannot be broken or injected through a pipe or macro character in a component name', () => {
      const evil = makeComponent('a | b {quote}x{quote} !http://evil.example/t.gif!:1', 'High', ['CVE-2099-1']);
      const wiki = buildGroupDescriptionWiki([evil, makeComponent('b:1', 'High', ['CVE-2099-2'])]);
      expect(wiki).not.toContain('{quote}');
      expect(wiki).not.toContain('!http://evil.example/t.gif!');
      const row = wiki.split('\n').find(l => l.startsWith('|a / b'))!;
      expect(row.split('|').length).toBe(6);
    });
  });

  describe('size budget (R10)', () => {
    const big = Array.from({ length: 12 }, (_, i) => ({
      ...makeComponent(`lib-${i}:1.0`, 'High', Array.from({ length: 40 }, (_, j) => `CVE-2099-${i}${j}`),
        id => `Summary for ${id} ` + 'lorem ipsum dolor sit amet '.repeat(40)),
      instancePaths: Array.from({ length: 60 }, (_, k) => `/app/services/very/long/path/number/${k}/pom.xml`),
    }));

    it('shortens per-component detail so twelve large components fit within 30,000 characters, and says so', () => {
      const wiki = buildGroupDescriptionWiki(big);
      expect(wiki.length).toBeLessThanOrEqual(30_000);
      expect(wiki).toContain('shortened');
    });

    it('still lists every component in the overview table', () => {
      const wiki = buildGroupDescriptionWiki(big);
      for (const c of big) expect(wiki).toContain(`|${sanitizeCellText(c.nameVersion)}|`);
    });

    it('does not mention shortening when everything fits', () => {
      expect(buildGroupDescriptionWiki([netty('a', '1', 'High'), netty('b', '1', 'High')])).not.toContain('shortened');
    });
  });

  describe('add comment (R14, R15)', () => {
    const group = [netty('netty-codec', '4.1.100', 'High', ['CVE-2099-1', 'CVE-2099-2']), netty('netty-handler', '4.1.100', 'High')];

    it('lists each added component with its CVE count under a banner', () => {
      const wiki = buildFoldedCommentWiki(group);
      expect(wiki.startsWith('These 2 components were added to this ticket.')).toBe(true);
      expect(wiki).toContain(`|${sanitizeCellText('netty-codec:4.1.100')}|High|2|1|`);
      expect(wiki).toContain(`|${sanitizeCellText('netty-handler:4.1.100')}|High|1|1|`);
    });

    it('names the component labels the ticket recorded that no longer appear in its description', () => {
      const wiki = buildFoldedCommentWiki(group, ['oss-dep-old-lib-1-0-abc123']);
      expect(wiki).toContain('No longer in the description');
      expect(wiki).toContain('oss-dep-old-lib-1-0-abc123');
    });

    it('has no dropped section when nothing was dropped', () => {
      expect(buildFoldedCommentWiki(group)).not.toContain('No longer in the description');
    });

    it('neutralizes a recorded label outside the normal label alphabet', () => {
      const wiki = buildFoldedCommentWiki(group, ['evil {quote}x{quote} !http://evil.example/t.gif!']);
      expect(wiki).not.toContain('{quote}');
      expect(wiki).not.toContain('!http://evil.example/t.gif!');
    });
  });
});
