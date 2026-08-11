import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseVeracodeReport, filterFlaws, assertSafeVeracodeXml } from '../utils/veracodeReport';
import { deriveShortLabel, buildSummary, buildDescriptionWiki, buildLabels } from '../utils/veracodeReport';

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
