import * as vscode from 'vscode';
import type { VeracodeSettings } from '../imports/veracode';
import type { WaltzSettings } from '../imports/waltz';
import type { EmailSettings } from '../imports/email';
import { resolveSizeLimitSetting } from '../utils/reportImport';

// The Veracode and Waltz import settings as VS Code holds them, read each time they are needed so a
// changed setting applies to the next step without a restart.

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('ticketSidekick');
}

/** `ticketSidekick.<kind>.maxReportSizeMB` as a byte limit. */
function maxReportBytes(kind: 'veracode' | 'waltz'): number {
  return resolveSizeLimitSetting(`${kind}.maxReportSizeMB`, key => cfg().get(key));
}

function getWaltzMinVulnRating(): string {
  return cfg().get<string>('waltz.minVulnRating') ?? 'High';
}

/** The Veracode filter, size and SLA settings. */
export const veracodeSettings: VeracodeSettings = {
  filter: () => ({
    minSeverity: cfg().get<number>('veracode.minSeverity') ?? 4,
    includeStatuses: cfg().get<string[]>('veracode.includeRemediationStatuses') ?? ['New', 'Open', 'Reopened'],
    maxReportBytes: maxReportBytes('veracode'),
  }),
  slaDays: () => cfg().get('veracode.slaDays'),
};

/** The Waltz filter and size settings, with the folder its accepted list lives in. */
export function waltzSettings(workspaceRoot: () => string | undefined): WaltzSettings {
  return {
    filter: () => ({
      minVulnRating: getWaltzMinVulnRating(),
      includeRemediationActions: cfg().get<string[]>('waltz.includeRemediationActions') ?? ['', 'Remediate'],
      maxReportBytes: maxReportBytes('waltz'),
    }),
    minVulnRating: getWaltzMinVulnRating,
    workspaceRoot,
  };
}

/** The email import's delete-after-import and batch-size settings. */
export const emailSettings: EmailSettings = {
  deleteEmlAfterImport: () => cfg().get<boolean>('email.deleteEmlAfterImport', false),
  maxBatchBytes: () => resolveSizeLimitSetting('email.maxBatchSizeMB', key => cfg().get(key)),
};
