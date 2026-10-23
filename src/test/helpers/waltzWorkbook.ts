import ExcelJS from 'exceljs';

// Builds an in-memory Waltz OSS report so tests never need a committed binary. Every value is invented.

export interface WorkbookComponent {
  nameVersion: string;
  maxVulnRating: string;
  remediationAction?: string | null;
  /** Expected Remediation (the policy date): text or a real date cell. */
  expectedRemediation?: string | Date | null;
  /** Remediation Target Date (the planned date). */
  targetDate?: string | Date | null;
  /** Attested Rem Plan Due By (the attestation date). */
  planDueBy?: string | Date | null;
  /** Reason, where plan invalid (the plan status). */
  planReason?: string | null;
}

export interface WorkbookOptions {
  components: WorkbookComponent[];
  /** Leave the four date and status columns out, like an older export. Default: included. */
  omitDateColumns?: boolean;
  instances?: Array<{ nameVersion: string; instancePath: string }>;
  vulnerabilities?: Array<{ nameVersion: string; cveId: string }>;
  /** Label and value pairs for the `ReportDetails` sheet (no header row); null leaves the sheet out. */
  reportDetails?: Array<[string, string | Date]> | null;
}

export async function buildWaltzWorkbook(options: WorkbookOptions): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  const remediations = workbook.addWorksheet('ComponentRemediations');
  const header = ['Component name and version', 'Max Vuln Rating', 'Remediation Action'];
  if (!options.omitDateColumns) {
    header.push('Expected Remediation', 'Remediation Target Date', 'Attested Rem Plan Due By', 'Reason, where plan invalid');
  }
  remediations.addRow(header);
  for (const c of options.components) {
    const row: Array<string | Date | null> = [c.nameVersion, c.maxVulnRating, c.remediationAction ?? null];
    if (!options.omitDateColumns) {
      row.push(c.expectedRemediation ?? null, c.targetDate ?? null, c.planDueBy ?? null, c.planReason ?? null);
    }
    remediations.addRow(row);
  }

  const instances = workbook.addWorksheet('VersionInstances');
  instances.addRow(['Component name and version', 'Component Instance Path']);
  for (const i of options.instances ?? []) instances.addRow([i.nameVersion, i.instancePath]);

  const vulnerabilities = workbook.addWorksheet('Vulnerabilities');
  vulnerabilities.addRow(['Component name and version', 'CVE Id']);
  for (const v of options.vulnerabilities ?? []) vulnerabilities.addRow([v.nameVersion, v.cveId]);

  if (options.reportDetails) {
    const details = workbook.addWorksheet('ReportDetails');
    for (const [label, value] of options.reportDetails) details.addRow([label, value]);
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
