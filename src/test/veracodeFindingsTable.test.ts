import { describe, it, expect } from 'vitest';
import { readVeracodeFindings } from '../utils/veracodeFindingsTable';
import { buildGroupDescriptionWiki, buildGroupLabels, buildGroupSummary, type VeracodeFlaw } from '../utils/veracodeReport';

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
    functionPrototype: 'void run()',
    remediationStatus: 'New',
    ...overrides,
  };
}

function ticketOf(group: VeracodeFlaw[]) {
  return { wiki: buildGroupDescriptionWiki(group), summary: buildGroupSummary(group), labels: buildGroupLabels(group) };
}

describe('readVeracodeFindings', () => {
  it('reads a folded ticket back to one record per finding with exact numbers and separate location cells', () => {
    const group = Array.from({ length: 7 }, (_, i) => makeFlaw({ issueId: String(1021 + i), line: 10 + i, severity: i % 6 }));
    const { wiki, summary, labels } = ticketOf(group);

    const result = readVeracodeFindings(wiki, { summary, labels });

    expect(result.detailSource).toBe('table');
    expect(result.edited).toBe(false);
    expect(result.findings).toHaveLength(7);
    expect(result.findings[2]).toMatchObject({
      issueId: '1023', severity: 2, cweId: '89', line: 12, module: 'ExampleApp.war',
      path: 'com/example/webapp/dao/', file: 'ExampleOrderDao.java', functionName: 'void run()', detailSource: 'table',
    });
    expect(result.findings[2].cweName).toContain('SQL Injection');
  });

  it('reads a one-finding ticket from the same table and keeps absent values null', () => {
    const flaw = makeFlaw({ issueId: '5', cweId: null, cweName: null, line: null, functionPrototype: null, sourceFile: null, sourceFilePath: null });
    const { wiki, summary, labels } = ticketOf([flaw]);

    const [finding] = readVeracodeFindings(wiki, { summary, labels }).findings;

    expect(finding).toMatchObject({ issueId: '5', cweId: null, cweName: null, line: null, file: null, path: null, functionName: null, module: 'ExampleApp.war' });
  });

  it('returns a sanitized text field as the ticket holds it and marks it approximate', () => {
    const flaw = makeFlaw({ issueId: '9', sourceFile: 'a|b.java' });
    const { wiki, summary, labels } = ticketOf([flaw]);

    const [finding] = readVeracodeFindings(wiki, { summary, labels }).findings;

    expect(finding.file).toBe('a/b.java');
    expect(finding.approximate).toBe(true);
    expect(finding.issueId).toBe('9');
    expect(finding.line).toBe(88);
  });

  it('reports a ticket whose table ids differ from its labels as edited, and still returns the readable rows', () => {
    const group = [makeFlaw({ issueId: '1' }), makeFlaw({ issueId: '2', line: 5 })];
    const { wiki, summary } = ticketOf(group);

    const result = readVeracodeFindings(wiki, { summary, labels: ['veracode', 'veracode-issue-1'] });

    expect(result.edited).toBe(true);
    expect(result.findings.map(f => f.issueId)).toEqual(['1', '2']);
  });

  it('matches column titles in any case and order', () => {
    const wiki = [
      '||line||FILE||issue id||path||severity||',
      '|42|Foo.java|77|src/|High (4)|',
    ].join('\n');

    const [finding] = readVeracodeFindings(wiki, { summary: null, labels: [] }).findings;

    expect(finding).toMatchObject({ issueId: '77', line: 42, file: 'Foo.java', path: 'src/', severity: 4, detailSource: 'table' });
  });

  it('reads a one-finding ticket made before the table existed from its Location block, as legacy', () => {
    const flaw = makeFlaw({ issueId: '1021' });
    const current = buildGroupDescriptionWiki([flaw]);
    // The earlier layout is today's without the leading Findings heading and table.
    const legacy = current.slice(current.indexOf('h3. Location'));

    const result = readVeracodeFindings(legacy, { summary: buildGroupSummary([flaw]), labels: buildGroupLabels([flaw]) });

    expect(result.detailSource).toBe('legacy');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      issueId: '1021', severity: 4, cweId: '89', module: 'ExampleApp.war', file: 'ExampleOrderDao.java', line: 88, functionName: 'void run()', approximate: true,
    });
  });

  it('reads the previous folded overview table, splitting its fused location at the last colon and slash', () => {
    const legacy = [
      'This ticket folds 2 Veracode findings.',
      '',
      '||Issue ID||Severity||CWE||Location||Function||',
      '|1001|Very High (5)|CWE-89|com/example/webapp/dao/ExampleOrderDao.java:10|void a()|',
      '|1002|Medium (3)|n/a|Other.java|n/a|',
    ].join('\n');

    const result = readVeracodeFindings(legacy, { summary: null, labels: [] });

    expect(result.detailSource).toBe('legacy');
    expect(result.findings[0]).toMatchObject({ issueId: '1001', severity: 5, cweId: '89', path: 'com/example/webapp/dao/', file: 'ExampleOrderDao.java', line: 10, functionName: 'void a()' });
    expect(result.findings[1]).toMatchObject({ issueId: '1002', cweId: null, path: null, file: 'Other.java', line: null, functionName: null });
  });

  it('falls back to the labels and the title when the description holds nothing readable', () => {
    const flaw = makeFlaw({ issueId: '31' });
    const result = readVeracodeFindings('Edited by hand.', { summary: buildGroupSummary([flaw]), labels: buildGroupLabels([flaw]) });

    expect(result.detailSource).toBe('title-labels');
    expect(result.findings).toEqual([expect.objectContaining({ issueId: '31', cweId: '89', file: 'ExampleOrderDao.java', line: 88, detailSource: 'title-labels', approximate: true })]);
  });

  it('takes the file from a folded title and leaves each line unknown', () => {
    const group = [makeFlaw({ issueId: '1', line: 1 }), makeFlaw({ issueId: '2', line: 2 })];
    const result = readVeracodeFindings(null, { summary: buildGroupSummary(group), labels: buildGroupLabels(group) });

    expect(result.findings.map(f => [f.issueId, f.file, f.line])).toEqual([['1', 'ExampleOrderDao.java', null], ['2', 'ExampleOrderDao.java', null]]);
  });

  it('returns nothing, not an error, for a ticket with no text and no finding labels', () => {
    expect(readVeracodeFindings(undefined, { summary: 'Something else', labels: ['bug'] }).findings).toEqual([]);
  });

  it('keeps every finding in the table after the description is shortened to fit', () => {
    const big = Array.from({ length: 40 }, (_, i) => makeFlaw({
      issueId: String(2000 + i), line: i + 1,
      description: 'lorem ipsum dolor sit amet '.repeat(80),
      recommendation: 'consectetur adipiscing elit '.repeat(80),
    }));
    const { wiki, summary, labels } = ticketOf(big);
    expect(wiki).toContain('shortened');

    const result = readVeracodeFindings(wiki, { summary, labels });

    expect(result.detailSource).toBe('table');
    expect(result.findings.map(f => f.issueId)).toEqual(big.map(f => f.issueId));
  });

  describe('a fold too large for the full table', () => {
    const huge = Array.from({ length: 400 }, (_, i) => makeFlaw({
      issueId: String(5000 + i), line: i + 1, functionPrototype: 'void aFairlyLongFunctionName(String firstArgument, int secondArgument)', description: 'x'.repeat(200),
    }));

    it('falls back to a slimmer table that still lists every finding and fits Jira\'s limit', () => {
      const { wiki, summary, labels } = ticketOf(huge);

      expect(wiki.length).toBeLessThanOrEqual(30_000);
      expect(wiki).toContain('leaves out the module, path, CWE name and function');
      const result = readVeracodeFindings(wiki, { summary, labels });
      expect(result.detailSource).toBe('table');
      expect(result.edited).toBe(false);
      expect(result.findings.map(f => f.issueId)).toEqual(huge.map(f => f.issueId));
      expect(result.findings[7]).toMatchObject({ severity: 4, cweId: '89', file: 'ExampleOrderDao.java', line: 8, module: null, path: null, functionName: null, cweName: null });
    });

    it('keeps the full table when it fits, and says nothing about leaving columns out', () => {
      const { wiki } = ticketOf(huge.slice(0, 20));
      expect(wiki).toContain('||Issue ID||Severity||CWE||CWE name||Module||Path||File||Line||Function||');
      expect(wiki).not.toContain('leaves out');
    });
  });
});
