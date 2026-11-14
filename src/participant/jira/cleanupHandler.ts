// The stale-ticket close of a Veracode or Waltz import, with logging to the Output channel. The grouping and the
// transition batch live in src/imports/cleanup.ts, which the import board shares.
import { logDiag } from '../../utils/diagLog';
import type { IJiraClient } from '../../jira/IJiraClient';
import type { TicketService } from '../../services/TicketService';
import type { StaleTicketMatch } from '../../utils/reportImport';
import type { TransitionBatchTicket } from '../sessionState';
import {
  buildStaleTicketGroups as buildStaleTicketGroupsCore,
  transitionTickets as transitionTicketsCore,
  type StaleGroupBuildResult,
  type TransitionRunResult,
} from '../../imports/cleanup';

export type { StaleGroupBuildResult, TransitionRunResult } from '../../imports/cleanup';

/** See src/imports/cleanup.ts; logs under `scope`. */
export function transitionTickets(
  tickets: TransitionBatchTicket[],
  ticketService: TicketService,
  defaultResolution: string | undefined,
  scope = 'jira.cleanup',
): Promise<TransitionRunResult> {
  return transitionTicketsCore(tickets, ticketService, defaultResolution, (level, message, details) => logDiag(scope, level, message, details));
}

/** See src/imports/cleanup.ts; logs under `scope`. */
export function buildStaleTicketGroups(
  staleMatches: StaleTicketMatch[],
  issueDetails: Map<string, { summary: string; currentStatus: string; issueType: string }>,
  projectKey: string,
  jiraClient: Pick<IJiraClient, 'getResolutions'>,
  workspaceRoot: string,
  scope = 'jira.cleanup',
): Promise<StaleGroupBuildResult> {
  return buildStaleTicketGroupsCore(staleMatches, issueDetails, projectKey, jiraClient, workspaceRoot, (level, message, details) => logDiag(scope, level, message, details));
}
