import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseVeracodeReport, filterFlaws, assertSafeVeracodeXml } from '../utils/veracodeReport';
import { deriveShortLabel, buildSummary, buildDescriptionWiki, buildLabels } from '../utils/veracodeReport';
import { chunkIssueIds, buildDedupJql, extractDedupMap } from '../utils/veracodeReport';
import { buildReviewRows } from '../utils/veracodeReport';

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
