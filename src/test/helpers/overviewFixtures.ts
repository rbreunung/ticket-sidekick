import { vi } from 'vitest';
import type { OverviewTicket } from '../../services/TicketService';
import type { MockJiraClient } from '../mocks/MockJiraClient';
import {
  buildGroupDescriptionWiki as buildVeracodeDescription, buildGroupLabels as buildVeracodeLabels, buildGroupSummary as buildVeracodeSummary,
  type VeracodeFlaw,
} from '../../utils/veracodeReport';
import {
  buildGroupDescriptionWiki as buildWaltzDescription, buildGroupLabels as buildWaltzLabels, buildGroupSummary as buildWaltzSummary,
  type WaltzComponent,
} from '../../utils/waltzReport';

export function makeFlaw(issueId: string, overrides: Partial<VeracodeFlaw> = {}): VeracodeFlaw {
  return {
    issueId, severity: 4, categoryName: 'SQL Injection', cweId: '89',
    cweName: "Improper Neutralization of Special Elements used in an SQL Command ('SQL Injection')",
    description: 'Some description.', recommendation: 'Some recommendation.', module: 'ExampleApp.war',
    sourceFile: 'OrderRepository.java', sourceFilePath: 'com/example/dao/', line: 88, scope: null,
    functionPrototype: 'void run()', remediationStatus: 'New', ...overrides,
  };
}

export function makeComponent(nameVersion: string, overrides: Partial<WaltzComponent> = {}): WaltzComponent {
  return {
    nameVersion, maxVulnRating: 'High', remediationAction: 'Remediate', instancePaths: ['/app/a.jar'],
    vulnerabilities: [{ cveId: 'CVE-2099-0001', cveSummary: null, overallSeverity: 'High', cvssV3Score: 7, fixedVersion: null }],
    remediation: { policyDate: '2026-11-30', plannedDate: null, attestationDate: null, planStatus: null, reportDate: null },
    ...overrides,
  };
}

export interface FixtureTicket { ticket: OverviewTicket; description: string }

export function veracodeTicket(key: string, group: VeracodeFlaw[], over: Partial<OverviewTicket> = {}): FixtureTicket {
  return {
    ticket: {
      key, summary: buildVeracodeSummary(group), status: 'Open', labels: buildVeracodeLabels(group), dueDate: null, fixVersions: [], source: 'veracode', ...over,
    },
    description: buildVeracodeDescription(group),
  };
}

export function waltzTicket(key: string, group: WaltzComponent[], over: Partial<OverviewTicket> = {}): FixtureTicket {
  return {
    ticket: {
      key, summary: buildWaltzSummary(group), status: 'Open', labels: buildWaltzLabels(group), dueDate: null, fixVersions: [], source: 'waltz', ...over,
    },
    description: buildWaltzDescription(group),
  };
}

export function descriptionsOf(tickets: FixtureTicket[]): Record<string, string> {
  return Object.fromEntries(tickets.map(t => [t.ticket.key, t.description]));
}

/**
 * Makes the mock Jira answer the overview's reads for these tickets: the search, each description and the
 * project's one release `2026.11` on 2026-11-15.
 */
export function seedOverviewJira(client: MockJiraClient, tickets: FixtureTicket[]): void {
  vi.spyOn(client, 'searchJql').mockResolvedValue({
    issues: tickets.map(t => ({
      id: t.ticket.key, key: t.ticket.key,
      fields: { summary: t.ticket.summary, status: { name: t.ticket.status }, labels: t.ticket.labels, fixVersions: t.ticket.fixVersions.map(name => ({ name })), duedate: t.ticket.dueDate },
    })) as never,
    total: tickets.length, isLast: true,
  });
  vi.spyOn(client, 'getIssue').mockImplementation(async key => ({
    id: key, key, fields: { description: tickets.find(t => t.ticket.key === key)!.description },
  }) as never);
  vi.spyOn(client, 'getProject').mockResolvedValue({
    id: '1', key: 'SEC', name: 'Security', issueTypes: [],
    versions: [{ id: '1', name: '2026.11', releaseDate: '2026-11-15' }],
  });
}
