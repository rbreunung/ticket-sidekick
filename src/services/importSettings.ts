import * as vscode from 'vscode';
import type { VeracodeSettings } from '../imports/veracode';
import type { WaltzSettings } from '../imports/waltz';
import { resolveSizeLimitSetting } from '../utils/reportImport';

// The Veracode and Waltz import settings as VS Code holds them, read each time they are needed so a
// changed setting applies to the next step without a restart. The one place their defaults live:
// the chat import and the import board both read them from here.

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('ticketSidekick');
}

/** `ticketSidekick.veracode.maxReportSizeMB` as a byte limit. */
export function getVeracodeMaxReportBytes(): number {
  return resolveSizeLimitSetting('veracode.maxReportSizeMB', key => cfg().get(key));
}

/** `ticketSidekick.waltz.maxReportSizeMB` as a byte limit. */
export function getWaltzMaxReportBytes(): number {
  return resolveSizeLimitSetting('waltz.maxReportSizeMB', key => cfg().get(key));
}

export function getWaltzMinVulnRating(): string {
  return cfg().get<string>('waltz.minVulnRating') ?? 'High';
}

/** The Veracode filter, size and SLA settings. */
export const veracodeSettings: VeracodeSettings = {
  filter: () => ({
    minSeverity: cfg().get<number>('veracode.minSeverity') ?? 4,
    includeStatuses: cfg().get<string[]>('veracode.includeRemediationStatuses') ?? ['New', 'Open', 'Reopened'],
    maxReportBytes: getVeracodeMaxReportBytes(),
  }),
  slaDays: () => cfg().get('veracode.slaDays'),
};

/** The Waltz filter and size settings, with the folder its accepted list lives in. */
export function waltzSettings(workspaceRoot: () => string | undefined): WaltzSettings {
  return {
    filter: () => ({
      minVulnRating: getWaltzMinVulnRating(),
      includeRemediationActions: cfg().get<string[]>('waltz.includeRemediationActions') ?? ['', 'Remediate'],
      maxReportBytes: getWaltzMaxReportBytes(),
    }),
    minVulnRating: getWaltzMinVulnRating,
    workspaceRoot,
  };
}
