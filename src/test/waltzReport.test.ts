import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseWaltzReport, assertSafeWaltzReportSize, filterComponents } from '../utils/waltzReport';

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
