import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseVeracodeReport, filterFlaws, assertSafeVeracodeXml } from '../utils/veracodeReport';
import { deriveShortLabel, buildSummary, buildDescriptionWiki, buildLabels } from '../utils/veracodeReport';
import {
  groupFlawsByLocation, buildGroupLabels, buildGroupDescriptionWiki, buildGroupSummary,
  type VeracodeFlaw,
} from '../utils/veracodeReport';

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

  it('keeps a well-formed numeric cweId so the CWE-database link still renders (unchanged existing behavior)', () => {
    const flaws = parseVeracodeReport(fixture('sample-report.xml'));
    const sqlInjection = flaws.find(f => f.issueId === '10101')!;
    expect(sqlInjection.cweId).toBe('89');
    const wiki = buildDescriptionWiki(sqlInjection);
    expect(wiki).toContain('[CWE-89|https://cwe.mitre.org/data/definitions/89.html]');
  });

  it('drops a malformed (non-numeric) cweId at parse time so it cannot be interpolated into the CWE-database link URL', () => {
    const tampered = fixture('sample-report.xml').replace(
      '<cwe cweid="89" cwename=',
      '<cwe cweid="89.html]notreal" cwename=',
    );
    const flaws = parseVeracodeReport(tampered);
    const sqlInjection = flaws.find(f => f.issueId === '10101')!;
    expect(sqlInjection.cweId).toBeNull();
    // No CWE section (and therefore no link) is rendered at all when cweId is dropped.
    const wiki = buildDescriptionWiki(sqlInjection);
    expect(wiki).not.toContain('h3. CWE');
    expect(wiki).not.toContain('89.html]notreal');
  });

  it('decodes numeric character references in attribute values (Veracode encodes literal parens in categoryname as &#x28;/&#x29;)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <detailedreport report_format_version="1.5" app_name="ExampleApp">
        <severity level="5">
          <category categoryid="18" categoryname="Cross-Site Scripting &#x28;XSS&#x29;">
            <desc/>
            <recommendations/>
            <cwe cweid="79" cwename="Improper Neutralization of Input During Web Page Generation &#x28;&apos;Cross-site Scripting&apos;&#x29;">
              <description/>
              <staticflaws>
                <flaw severity="5" categoryname="Cross-Site Scripting &#x28;XSS&#x29;" issueid="1234" module="IDPHelper.war"
                      type="Cross-Site Scripting &#x28;XSS&#x29;"
                      description="Reflected XSS &#x28;see CWE-79&#x29;" cweid="79" remediationeffort="3"
                      categoryid="18" date_first_occurrence="2026-05-01T10:00:00.000-0000" remediation_status="New"
                      sourcefile="IDPHelper.java" line="228" sourcefilepath="com/example/webapp/" mitigation_status="none"/>
              </staticflaws>
            </cwe>
          </category>
        </severity>
      </detailedreport>`;
    const flaws = parseVeracodeReport(xml);
    expect(flaws).toHaveLength(1);
    expect(flaws[0].categoryName).toBe('Cross-Site Scripting (XSS)');
    expect(flaws[0].cweName).toBe("Improper Neutralization of Input During Web Page Generation ('Cross-site Scripting')");
    expect(flaws[0].description).toBe('Reflected XSS (see CWE-79)');
    // deriveShortLabel prefers the CWE's own quoted short name over categoryname (see Task 4 tests) —
    // real MITRE CWE-79 name quotes "Cross-site Scripting", so that's what ends up in the summary.
    expect(buildSummary(flaws[0])).toBe('1234 - IDPHelper.java:228 - Cross-site Scripting');
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

  it('accepts a document under the default 20 MB cap but over a smaller custom maxBytes at the default only', () => {
    const twentyFiveMb = '<detailedreport>' + 'x'.repeat(25 * 1024 * 1024) + '</detailedreport>';
    expect(() => assertSafeVeracodeXml(twentyFiveMb)).toThrow(/size limit/i);
    expect(() => assertSafeVeracodeXml(twentyFiveMb, 50 * 1024 * 1024)).not.toThrow();
  });

  it('rejects a document over a custom maxBytes, reporting that custom limit in the message', () => {
    const tenMb = '<detailedreport>' + 'x'.repeat(10 * 1024 * 1024) + '</detailedreport>';
    expect(() => assertSafeVeracodeXml(tenMb, 5 * 1024 * 1024)).toThrow(/5 MB size limit/);
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
    // Description/Recommendation are standalone-line values, so each is prefixed with ": " to keep
    // it out of line-start position (see sanitizeStandaloneLine() in reportImport.ts) — the
    // information itself (starting text) is unchanged, just no longer flush against the heading.
    expect(wiki).toContain('h3. Description\n: The method buildOrderQuery()');
    expect(wiki).toContain('h3. Recommendation\n: Use parameterized queries');
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

  // AE5 — mirrors waltzReport.test.ts's crafted-payload test (same shape of payload, same shape of
  // assertions); proves the Markdown-then-sanitize-then-convert pipeline closes the same class of gap
  // for a Veracode-only field (description) that AE1 already proved for Waltz's cveSummary. See
  // docs/solutions/security-issues/waltz-oss-report-markdown-injection-in-jira-wiki-converter.md.
  it('neutralizes markdown-structural characters in untrusted flaw text so a crafted description cannot inject a heading, table row, link, bold/italic text, or strikethrough', () => {
    const flaws = parseVeracodeReport(fixture('sample-report.xml'));
    const malicious = {
      ...flaws.find(f => f.issueId === '10101')!,
      description: 'Injected\n# Fake Heading\n| a | b |\n[click me](http://evil.example) *bold* ~~strike~~\n1. urgent\n--- rule\n> quote'
        + '\n-struck- +underline+ ^super^ ??cite?? {quote}FAKE{quote} !http://evil.example/t.gif!',
    };
    const wiki = buildDescriptionWiki(malicious);
    expect(wiki).not.toContain('h1. Fake Heading');
    expect(wiki).not.toContain('||a||b||');
    expect(wiki).not.toContain('[click me|http://evil.example]');
    expect(wiki).not.toContain('*bold*');
    expect(wiki).not.toContain('~~strike~~');
    expect(wiki).not.toContain('-strike-');
    expect(wiki).not.toContain('# urgent');
    expect(wiki).not.toContain('----');
    expect(wiki).not.toContain('{quote}');
    // Jira-native trigger characters the converter itself never touches (Finding #1)
    expect(wiki).not.toContain('+underline+');
    expect(wiki).not.toContain('^super^');
    expect(wiki).not.toContain('??cite??');
    expect(wiki).not.toContain('!http://evil.example/t.gif!');
    expect(wiki).not.toMatch(/[+^?{}!]/);
  });

  // Finding #6 follow-up: the test above only exercised `description`. `recommendation` goes
  // through the identical sanitizeStandaloneLine() call site (see buildDescriptionWiki()), so it
  // needs its own crafted-payload proof — a regression that broke only the recommendation call
  // site would otherwise go undetected by the description-only test.
  it('neutralizes markdown-structural characters in a crafted recommendation the same way as description', () => {
    const flaws = parseVeracodeReport(fixture('sample-report.xml'));
    const malicious = {
      ...flaws.find(f => f.issueId === '10101')!,
      recommendation: 'Injected\n# Fake Heading\n| a | b |\n[click me](http://evil.example) *bold* ~~strike~~\n1. urgent\n--- rule\n> quote'
        + '\n-struck- +underline+ ^super^ ??cite?? {quote}FAKE{quote} !http://evil.example/t.gif!',
    };
    const wiki = buildDescriptionWiki(malicious);
    expect(wiki).not.toContain('h1. Fake Heading');
    expect(wiki).not.toContain('||a||b||');
    expect(wiki).not.toContain('[click me|http://evil.example]');
    expect(wiki).not.toContain('*bold*');
    expect(wiki).not.toContain('~~strike~~');
    expect(wiki).not.toContain('-strike-');
    expect(wiki).not.toContain('# urgent');
    expect(wiki).not.toContain('----');
    expect(wiki).not.toContain('{quote}');
    expect(wiki).not.toContain('+underline+');
    expect(wiki).not.toContain('^super^');
    expect(wiki).not.toContain('??cite??');
    expect(wiki).not.toContain('!http://evil.example/t.gif!');
    expect(wiki).not.toMatch(/[+^?{}!]/);
  });

  // Finding #6 follow-up: module, sourceFile/sourceFilePath (via fullSourcePath()), and cweName are
  // the remaining flaw fields routed through sanitizeCellText() mid-line in buildDescriptionWiki() —
  // none of them previously had a malicious-input assertion, only the happy-path "renders all
  // sections" test with clean fixture data. One crafted-payload case per field proves each call
  // site independently strips/neutralizes the same markdown-structural characters.
  it('neutralizes markdown-structural characters in a crafted module value', () => {
    const flaws = parseVeracodeReport(fixture('sample-report.xml'));
    const malicious = {
      ...flaws.find(f => f.issueId === '10101')!,
      module: 'Evil | a | b | [click me](http://evil.example) *bold* ~~strike~~',
    };
    const wiki = buildDescriptionWiki(malicious);
    expect(wiki).not.toContain('||a||b||');
    expect(wiki).not.toContain('[click me|http://evil.example]');
    expect(wiki).not.toContain('*bold*');
    expect(wiki).not.toContain('~~strike~~');
    expect(wiki).not.toContain('-strike-');
  });

  it('neutralizes markdown-structural characters in a crafted sourceFile/sourceFilePath value', () => {
    const flaws = parseVeracodeReport(fixture('sample-report.xml'));
    const malicious = {
      ...flaws.find(f => f.issueId === '10101')!,
      sourceFilePath: 'evil | a | b | [click me](http://evil.example)/',
      sourceFile: '*bold* ~~strike~~ path.java',
    };
    const wiki = buildDescriptionWiki(malicious);
    expect(wiki).not.toContain('||a||b||');
    expect(wiki).not.toContain('[click me|http://evil.example]');
    expect(wiki).not.toContain('*bold*');
    expect(wiki).not.toContain('~~strike~~');
    expect(wiki).not.toContain('-strike-');
  });

  it('neutralizes markdown-structural characters in a crafted cweName value', () => {
    const flaws = parseVeracodeReport(fixture('sample-report.xml'));
    const malicious = {
      ...flaws.find(f => f.issueId === '10101')!,
      cweName: 'Evil | a | b | [click me](http://evil.example) *bold* ~~strike~~',
    };
    const wiki = buildDescriptionWiki(malicious);
    expect(wiki).not.toContain('||a||b||');
    expect(wiki).not.toContain('[click me|http://evil.example]');
    expect(wiki).not.toContain('*bold*');
    expect(wiki).not.toContain('~~strike~~');
    expect(wiki).not.toContain('-strike-');
  });

  // functionPrototype is also a sanitizeCellText() mid-line call site — kept as its own test (rather
  // than folded into the group above) so a crafted function signature gets the same standalone
  // proof as the other five sanitized fields.
  it('neutralizes markdown-structural characters in a crafted functionPrototype value', () => {
    const flaws = parseVeracodeReport(fixture('sample-report.xml'));
    const malicious = {
      ...flaws.find(f => f.issueId === '10101')!,
      functionPrototype: 'Evil | a | b | [click me](http://evil.example) *bold* ~~strike~~',
    };
    const wiki = buildDescriptionWiki(malicious);
    expect(wiki).not.toContain('||a||b||');
    expect(wiki).not.toContain('[click me|http://evil.example]');
    expect(wiki).not.toContain('*bold*');
    expect(wiki).not.toContain('~~strike~~');
    expect(wiki).not.toContain('-strike-');
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

// chunkIssueIds/buildDedupJql/extractDedupMap/buildReviewRows were Veracode-local wrappers around
// the shared primitives in reportImport.ts; they've been removed now that veracodeHandler.ts calls
// those shared primitives directly (KTD2) — see reportImport.test.ts for their tests.

// U1 — folding same-line flaws into a single grouped ticket. `makeFlaw` builds a full VeracodeFlaw
// with sensible defaults so each test only needs to override the fields it cares about (rather than
// relying on fixture XML, which can't easily express the missing-location / multi-CWE-at-one-line
// cases these tests need).
function makeFlaw(overrides: Partial<VeracodeFlaw> & { issueId: string }): VeracodeFlaw {
  return {
    severity: 4,
    categoryName: 'SQL Injection',
    cweId: '89',
    cweName: "Improper Neutralization of Special Elements used in an SQL Command ('SQL Injection')",
    description: 'Some description.',
    recommendation: 'Some recommendation.',
    module: 'ExampleApp.war',
    sourceFile: 'ExampleOrderDao.java',
    sourceFilePath: 'com/example/webapp/dao/',
    line: 88,
    scope: null,
    functionPrototype: null,
    remediationStatus: 'New',
    ...overrides,
  };
}

describe('groupFlawsByLocation', () => {
  it('folds two flaws sharing the same source file and line into one group, regardless of CWE or category', () => {
    const a = makeFlaw({
      issueId: '1', cweId: '89', categoryName: 'SQL Injection',
    });
    const b = makeFlaw({
      issueId: '2', cweId: '79', categoryName: 'Cross-Site Scripting',
    });
    const groups = groupFlawsByLocation([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0].map(f => f.issueId)).toEqual(['1', '2']);
  });

  it('does not fold flaws at the same line in different files', () => {
    const a = makeFlaw({ issueId: '1', sourceFile: 'Foo.java', line: 10 });
    const b = makeFlaw({ issueId: '2', sourceFile: 'Bar.java', line: 10 });
    const groups = groupFlawsByLocation([a, b]);
    expect(groups).toHaveLength(2);
  });

  it('never folds a flaw with a null sourceFile, even with an otherwise-identical line in another flaw', () => {
    const a = makeFlaw({ issueId: '1', sourceFile: null, line: 10 });
    const b = makeFlaw({ issueId: '2', sourceFile: null, line: 10 });
    const groups = groupFlawsByLocation([a, b]);
    // Both lack a source file, so neither folds with the other OR with itself-in-spirit — each stays
    // its own singleton group.
    expect(groups).toHaveLength(2);
    expect(groups.every(g => g.length === 1)).toBe(true);
  });

  it('never folds a flaw with a null line, even with an otherwise-identical source file in another flaw', () => {
    const a = makeFlaw({ issueId: '1', sourceFile: 'Foo.java', line: null });
    const b = makeFlaw({ issueId: '2', sourceFile: 'Foo.java', line: null });
    const groups = groupFlawsByLocation([a, b]);
    expect(groups).toHaveLength(2);
    expect(groups.every(g => g.length === 1)).toBe(true);
  });

  it('does not fold two flaws whose sourceFilePath+sourceFile concatenation collides without the "::" separator', () => {
    // Naive concatenation (sourceFilePath + sourceFile) would produce the identical string
    // "src/foo/bar.js" for both of these, even though the path/file split is genuinely different.
    const a = makeFlaw({ issueId: '1', sourceFilePath: 'src/foo/', sourceFile: 'bar.js', line: 10 });
    const b = makeFlaw({ issueId: '2', sourceFilePath: 'src/foo/bar.', sourceFile: 'js', line: 10 });
    const groups = groupFlawsByLocation([a, b]);
    expect(groups).toHaveLength(2);
  });

  it('preserves first-occurrence group order and in-group member order across a mixed list', () => {
    const a1 = makeFlaw({ issueId: '1', sourceFile: 'A.java', line: 1 });
    const b1 = makeFlaw({ issueId: '2', sourceFile: 'B.java', line: 2 });
    const a2 = makeFlaw({ issueId: '3', sourceFile: 'A.java', line: 1 });
    const groups = groupFlawsByLocation([a1, b1, a2]);
    expect(groups).toHaveLength(2);
    expect(groups[0].map(f => f.issueId)).toEqual(['1', '3']);
    expect(groups[1].map(f => f.issueId)).toEqual(['2']);
  });
});

describe('buildGroupLabels', () => {
  it('unions veracode-issue-<id> for every folded flaw', () => {
    const a = makeFlaw({ issueId: '1', cweId: '89' });
    const b = makeFlaw({ issueId: '2', cweId: '89' });
    const labels = buildGroupLabels([a, b]);
    expect(labels).toContain('veracode-issue-1');
    expect(labels).toContain('veracode-issue-2');
  });

  it('contributes one cwe-<id> label per distinct CWE among the group, deduping a repeated CWE', () => {
    const a = makeFlaw({ issueId: '1', cweId: '89' });
    const b = makeFlaw({ issueId: '2', cweId: '89' }); // same CWE as a — should not duplicate
    const c = makeFlaw({ issueId: '3', cweId: '79' }); // distinct CWE — should add its own label
    const labels = buildGroupLabels([a, b, c]);
    expect(labels.filter(l => l === 'cwe-89')).toHaveLength(1);
    expect(labels).toContain('cwe-79');
  });

  it('merges in template labels and de-duplicates', () => {
    const a = makeFlaw({ issueId: '1', cweId: '89' });
    const b = makeFlaw({ issueId: '2', cweId: '79' });
    const labels = buildGroupLabels([a, b], ['security', 'veracode']);
    expect(labels).toEqual(['veracode', 'veracode-issue-1', 'cwe-89', 'veracode-issue-2', 'cwe-79', 'security']);
  });

  it('a flaw missing a CWE contributes no cwe-<id> label but its issue id still appears', () => {
    const a = makeFlaw({ issueId: '1', cweId: null });
    const b = makeFlaw({ issueId: '2', cweId: '89' });
    const labels = buildGroupLabels([a, b]);
    expect(labels).toContain('veracode-issue-1');
    expect(labels).toContain('cwe-89');
    expect(labels.filter(l => l.startsWith('cwe-'))).toEqual(['cwe-89']);
  });
});

describe('buildGroupDescriptionWiki', () => {
  it("combines both flaws' sections (severity, CWE, description, recommendation) under their own issue heading, hoisting the shared location once", () => {
    const a = makeFlaw({
      issueId: '1', severity: 5, cweId: '89', description: 'First flaw description.', recommendation: 'First recommendation.',
    });
    const b = makeFlaw({
      issueId: '2', severity: 3, cweId: '79', description: 'Second flaw description.', recommendation: 'Second recommendation.',
    });
    const wiki = buildGroupDescriptionWiki([a, b]);

    // Location hoisted once (both flaws share module/sourceFile/line via makeFlaw defaults).
    expect(wiki.match(/h3\. Location/g)).toHaveLength(1);
    expect(wiki).toContain('File: com/example/webapp/dao/ExampleOrderDao.java:88');

    // Each flaw gets its own issue section with its own severity/CWE/description/recommendation.
    expect(wiki).toContain('h3. Issue 1');
    expect(wiki).toContain('h4. Severity\nVery High (5)');
    expect(wiki).toContain('[CWE-89|https://cwe.mitre.org/data/definitions/89.html]');
    expect(wiki).toContain(': First flaw description.');
    expect(wiki).toContain(': First recommendation.');

    expect(wiki).toContain('h3. Issue 2');
    expect(wiki).toContain('h4. Severity\nMedium (3)');
    expect(wiki).toContain('[CWE-79|https://cwe.mitre.org/data/definitions/79.html]');
    expect(wiki).toContain(': Second flaw description.');
    expect(wiki).toContain(': Second recommendation.');
  });

  it('omits the Recommendation and CWE sections for a folded flaw missing that data, independently per flaw', () => {
    const a = makeFlaw({ issueId: '1', cweId: '89', recommendation: 'Has a recommendation.' });
    const b = makeFlaw({ issueId: '2', cweId: null, recommendation: null });
    const wiki = buildGroupDescriptionWiki([a, b]);
    // Issue 1 keeps its recommendation and CWE; Issue 2 has neither.
    const issue2Section = wiki.split('h3. Issue 2')[1];
    expect(issue2Section).not.toContain('h4. CWE');
    expect(issue2Section).not.toContain('h4. Recommendation');
  });

  it('routes every untrusted field (module, description, recommendation) in a folded group through the existing sanitizers, never a raw concatenation bypass', () => {
    const payload = 'Injected\n# Fake Heading\n| a | b |\n[click me](http://evil.example) *bold* ~~strike~~'
      + '\n-struck- +underline+ ^super^ ??cite?? {quote}FAKE{quote} !http://evil.example/t.gif!';
    const a = makeFlaw({
      issueId: '1', module: `Evil | a | b | [click me](http://evil.example) *bold*`, description: payload, recommendation: payload,
    });
    const b = makeFlaw({ issueId: '2', description: 'clean' });
    const wiki = buildGroupDescriptionWiki([a, b]);

    expect(wiki).not.toContain('h1. Fake Heading');
    expect(wiki).not.toContain('||a||b||');
    expect(wiki).not.toContain('[click me|http://evil.example]');
    expect(wiki).not.toContain('*bold*');
    expect(wiki).not.toContain('~~strike~~');
    expect(wiki).not.toContain('-strike-');
    expect(wiki).not.toContain('{quote}');
    expect(wiki).not.toMatch(/[+^?{}!]/);
  });

  it('a single-member group still renders correctly (folding is a superset of the unfolded case)', () => {
    const a = makeFlaw({ issueId: '1' });
    const wiki = buildGroupDescriptionWiki([a]);
    expect(wiki).toContain('h3. Issue 1');
    expect(wiki).toContain('h4. Severity');
  });
});

describe('buildGroupSummary', () => {
  it('matches buildSummary() exactly for a singleton group', () => {
    const a = makeFlaw({ issueId: '1' });
    expect(buildGroupSummary([a])).toBe(buildSummary(a));
  });

  it('lists every folded issue id and notes how many additional flaws are folded in', () => {
    const a = makeFlaw({ issueId: '1', sourceFile: 'Foo.java', line: 42, categoryName: 'SQL Injection', cweName: null });
    const b = makeFlaw({ issueId: '2', sourceFile: 'Foo.java', line: 42, categoryName: 'SQL Injection', cweName: null });
    const c = makeFlaw({ issueId: '3', sourceFile: 'Foo.java', line: 42, categoryName: 'SQL Injection', cweName: null });
    const summary = buildGroupSummary([a, b, c]);
    expect(summary).toContain('1, 2, 3');
    expect(summary).toContain('Foo.java:42');
    expect(summary).toContain('(+2 more)');
  });
});
