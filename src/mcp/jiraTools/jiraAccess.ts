import type { IJiraClient } from '../../jira/IJiraClient';
import type { JiraConfig } from '../../services/ConfigService';
import type { DiagLogger } from '../../utils/diagTypes';

// What every Jira tool handler receives. The caller builds one `JiraToolDeps` when the server
// starts; `getJira()` reads the settings and credentials again at every tool call, so a token set
// or a setting changed while the server runs is seen without a restart.

export type ConfiguredJiraConfig = JiraConfig & { baseUrl: string; token: string };

export type JiraAccess =
  | { configured: true; config: ConfiguredJiraConfig; client: IJiraClient }
  | { configured: false; config: JiraConfig };

export interface JiraToolDeps {
  /** The current Jira settings, plus a client when the base URL and the token are both set. */
  getJira(): Promise<JiraAccess>;
  onDiag?: DiagLogger;
}
