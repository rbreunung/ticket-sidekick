import { TicketService } from '../services/TicketService';
import { resolveExtraColumns, type ResolvedColumn } from '../services/extraColumns';
import type { JiraAccess } from '../tools/jiraTools/jiraAccess';
import type { DiagLogger } from '../utils/diagTypes';

// The extra columns `ticketSidekick.jira.securityReportFields` asks for, read when a board reads Jira. The security
// report and the import board both build their reading on this, so a setting change reaches them the same way.

/** A reader of the configured columns: Assignee is built in and never listed here, and Jira is asked for field names only when an id is configured. */
export function overviewColumnsReader(getJira: () => Promise<JiraAccess>, onDiag?: DiagLogger): () => Promise<ResolvedColumn[]> {
  return async () => {
    const access = await getJira();
    if (!access.configured) return [];
    return resolveExtraColumns(
      access.config.securityReportFields,
      () => new TicketService(access.client, onDiag).getFieldMeta(),
      { setting: 'securityReportFields', builtIn: ['assignee'], onDiag },
    );
  };
}
