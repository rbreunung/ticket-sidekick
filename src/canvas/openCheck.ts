import { sendJson, type CanvasRoute } from './canvasRoutes';
import { projectFromInput, projectRequest, type OpenCheck } from './openDecision';

// The route the canvas program calls before it hands the agent a page address: it resolves the
// project (the one asked for, else the window's default project; a named text that is not a
// project key is refused) and says whether Jira is set up in this window, so the open status can
// name the reason a canvas did not open.

export const OPEN_CHECK_PATH = '/api/open-check';

export interface OpenCheckDeps {
  isJiraConfigured(): Promise<boolean>;
  /** `ticketSidekick.jira.defaultProject` of this window, possibly empty. */
  defaultProject(): string;
}

export async function checkOpen(requested: string | null, deps: OpenCheckDeps): Promise<OpenCheck> {
  // A named project is used as named: one that is not a project key is refused, never swapped
  // for the default project, so the report shown is always the one asked for.
  const asked = projectRequest({ project: requested ?? undefined });
  if (asked.kind === 'invalid') return { ok: false, reason: 'invalid-project' };
  const project = asked.kind === 'valid' ? asked.project : projectFromInput({ project: deps.defaultProject() });
  if (!project) return { ok: false, reason: 'no-project' };
  if (!(await deps.isJiraConfigured())) return { ok: false, reason: 'not-configured' };
  return { ok: true, project };
}

export function openCheckRoute(deps: OpenCheckDeps): CanvasRoute {
  return {
    method: 'GET',
    path: OPEN_CHECK_PATH,
    handle: async (_req, res, ctx) => sendJson(res, 200, await checkOpen(ctx.query.get('project'), deps)),
  };
}
