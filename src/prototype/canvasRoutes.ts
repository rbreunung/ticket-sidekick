import type * as http from 'http';
import type { JiraAccess } from './mcpEndpoint';
import { buildCommentPreview, isTicketKey } from './mcpEndpoint';
import type { PlanStore } from './planStore';
import { buildBoardHtml } from './boardPage';

// The canvas board, served under the canvas key: the page itself, the ticket list, and the two-step
// write (plan with preview, then apply). Writes accept JSON only, so a plain HTML form elsewhere
// cannot post here; the request guard has already refused foreign origins.

export interface CommentPlan {
  ticketKey: string;
  comment: string;
}

export interface CanvasDeps {
  getJira(): Promise<JiraAccess>;
  getProjectKey(): string;
  plans: PlanStore<CommentPlan>;
  onError?(message: string): void;
}

const PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TICKETS = 50;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isJson(req: http.IncomingMessage): boolean {
  return (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() === 'application/json';
}

export function createCanvasHandler(deps: CanvasDeps): (req: http.IncomingMessage, res: http.ServerResponse, subPath: string) => Promise<void> {
  return async (req, res, subPath) => {
    const method = req.method ?? 'GET';

    if (method === 'GET' && subPath === '/') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(buildBoardHtml());
      return;
    }

    if (method === 'GET' && subPath === '/api/tickets') {
      const project = deps.getProjectKey().trim();
      if (!PROJECT_KEY.test(project)) {
        sendJson(res, 400, { error: 'Set ticketSidekick.jira.defaultProject to a Jira project key first.' });
        return;
      }
      const jira = await deps.getJira();
      if (!jira.configured) { sendJson(res, 503, { error: jira.message }); return; }
      const result = await jira.ticketService.searchTicketsRaw(
        `project = "${project}" AND resolution is EMPTY ORDER BY updated DESC`, MAX_TICKETS, ['status', 'updated'],
      );
      const tickets = result.issues.map(issue => ({
        key: issue.key,
        summary: issue.fields.summary ?? '',
        status: issue.fields.status?.name ?? '',
      }));
      sendJson(res, 200, { project, tickets });
      return;
    }

    if (method === 'POST' && (subPath === '/api/plan' || subPath === '/api/apply')) {
      if (!isJson(req)) { sendJson(res, 415, { error: 'Send JSON.' }); return; }
      let body: Record<string, unknown>;
      try {
        body = (await readJson(req)) as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { error: 'Invalid request body.' });
        return;
      }

      if (subPath === '/api/plan') {
        const ticketKey = typeof body.ticketKey === 'string' ? body.ticketKey.trim() : '';
        const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
        if (!isTicketKey(ticketKey)) { sendJson(res, 400, { error: 'Pick a ticket first.' }); return; }
        if (!comment) { sendJson(res, 400, { error: 'Write a comment first.' }); return; }
        const planId = deps.plans.add({ ticketKey, comment });
        sendJson(res, 200, { planId, preview: buildCommentPreview(ticketKey, comment) });
        return;
      }

      const plan = typeof body.planId === 'string' ? deps.plans.take(body.planId) : undefined;
      if (!plan) { sendJson(res, 409, { error: 'This preview was already applied or has expired. Create a new one.' }); return; }
      const jira = await deps.getJira();
      if (!jira.configured) { sendJson(res, 503, { error: jira.message }); return; }
      try {
        const message = await jira.ticketService.addComment(plan.ticketKey, plan.comment, jira.baseUrl);
        sendJson(res, 200, { message });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.onError?.(`board comment failed: ${message}`);
        sendJson(res, 502, { error: `Could not add the comment: ${message}` });
      }
      return;
    }

    sendJson(res, 404, { error: 'Not found.' });
  };
}
