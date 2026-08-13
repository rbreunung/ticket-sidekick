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
