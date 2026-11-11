import { sendJson, type CanvasRoute } from './canvasRoutes';
import { projectFromInput, type OpenCheck } from './openDecision';

// The route the canvas program calls before it hands the agent a page address: it resolves the
// project (the one asked for, else the window's default project) and says whether Jira is set up
// in this window, so the open status can name the reason a canvas did not open.

export const OPEN_CHECK_PATH = '/api/open-check';

export interface OpenCheckDeps {
  isJiraConfigured(): Promise<boolean>;
  /** `ticketSidekick.jira.defaultProject` of this window, possibly empty. */
  defaultProject(): string;
}

export async function checkOpen(requested: string | null, deps: OpenCheckDeps): Promise<OpenCheck> {
  const project = projectFromInput({ project: requested ?? '' }) ?? projectFromInput({ project: deps.defaultProject() });
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
