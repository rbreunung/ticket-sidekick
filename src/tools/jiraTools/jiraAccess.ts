import type { IJiraClient } from '../../jira/IJiraClient';
import type { JiraConfig } from '../../services/ConfigService';
import type { RecentCallGuard } from '../../tools/recentCallGuard';
import type { DiagLogger } from '../../utils/diagTypes';

// What every Jira tool handler receives. The extension builds one `JiraToolDeps` at activation;
// `getJira()` reads the settings and credentials again at every tool call, so a token set or a
// setting changed later is seen without a restart.

export type ConfiguredJiraConfig = JiraConfig & { baseUrl: string; token: string };

export type JiraAccess =
  | { configured: true; config: ConfiguredJiraConfig; client: IJiraClient }
  | { configured: false; config: JiraConfig };

export interface JiraToolDeps {
  /** The current Jira settings, plus a client when the base URL and the token are both set. */
  getJira(): Promise<JiraAccess>;
  /**
   * The open workspace folders as file system paths, read at every call. The first one is where
   * the git branch is read and where the template and workflow cache files live.
   */
  workspaceFolders(): string[];
  /** How long one Jira request may take before the tool answers that Jira did not respond; 30 seconds when unset. */
  jiraTimeoutMs?: number;
  /**
   * How long one attachment download may take before the load reports that attachment as not
   * downloaded and goes on with the rest; 2 minutes when unset.
   */
  jiraDownloadTimeoutMs?: number;
  /**
   * Remembers the writes of the last minute (comments, created tickets, uploads), so an identical
   * call repeated shortly after is skipped instead of writing twice. Created once at activation.
   */
  recentWrites: RecentCallGuard;
  /** Opens a board in an editor tab of this window; absent where boards are not available. */
  openBoard?(kind: string, input: unknown): Promise<{ ok: true; title: string } | { ok: false; reason: string }>;
  onDiag?: DiagLogger;
}
