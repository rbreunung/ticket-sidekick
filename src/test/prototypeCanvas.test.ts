import { describe, it, expect, afterEach } from 'vitest';
import { LocalhostServer } from '../prototype/localhostServer';
import { createCanvasHandler, type CanvasDeps, type CommentPlan } from '../prototype/canvasRoutes';
import { PlanStore } from '../prototype/planStore';
import { generateKey } from '../prototype/keys';
import { TicketService } from '../services/TicketService';
import { MockJiraClient } from './mocks/MockJiraClient';
import type { JiraSearchResult } from '../jira/IJiraClient';

class RecordingJiraClient extends MockJiraClient {
  public jqls: string[] = [];
  override async searchJql(jql: string, maxResults?: number, startAt?: number, extraFields?: string[], pageToken?: string): Promise<JiraSearchResult> {
    this.jqls.push(jql);
    const result = await super.searchJql(jql, maxResults, startAt, extraFields, pageToken);
    result.issues[0].fields.summary = '<script>alert(1)</script>';
    return result;
  }
}

let server: LocalhostServer | undefined;
afterEach(async () => { await server?.stop(); server = undefined; });

async function start(projectKey = 'PROJ') {
  const jira = new RecordingJiraClient();
  const plans = new PlanStore<CommentPlan>();
  const deps: CanvasDeps = {
    getJira: async () => ({ configured: true, ticketService: new TicketService(jira), baseUrl: 'https://jira.example' }),
    getProjectKey: () => projectKey,
    plans,
  };
  const canvasKey = generateKey();
  server = new LocalhostServer({ onMcp: async (_q, r) => { r.statusCode = 404; r.end(); }, onCanvas: createCanvasHandler(deps) });
  const port = await server.start({ mcpKey: generateKey(), canvasKey });
  const base = `http://127.0.0.1:${port}/${canvasKey}`;
  const origin = `http://127.0.0.1:${port}`;
  return { jira, plans, base, origin };
}

function post(url: string, origin: string, body: unknown, contentType = 'application/json') {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': contentType, Origin: origin }, body: JSON.stringify(body) });
}

describe('prototype canvas board', () => {
  it('serves a self-contained board page that renders Jira text as text', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<html');
    expect(html).not.toMatch(/(src|href)=["']https?:/);
    expect(html).not.toContain('innerHTML');
  });

  it('lists the default project’s unresolved tickets, most recently updated first', async () => {
    const { base, jira } = await start('PROJ');
    const res = await fetch(`${base}/api/tickets`);
    const data = await res.json() as { project: string; tickets: Array<{ key: string; summary: string }> };
    expect(data.project).toBe('PROJ');
    expect(data.tickets.map(t => t.key)).toEqual(['PROJ-123', 'PROJ-124']);
    expect(data.tickets[0].summary).toBe('<script>alert(1)</script>');
    expect(jira.jqls[0]).toBe('project = "PROJ" AND resolution is EMPTY ORDER BY updated DESC');
  });

  it('refuses to list tickets when the default project key is not a project key', async () => {
    const { base, jira } = await start('PROJ" OR 1=1');
    const res = await fetch(`${base}/api/tickets`);
    expect(res.status).toBe(400);
    expect(jira.jqls).toEqual([]);
  });

  it('refuses a plan with an invalid ticket key and stores nothing', async () => {
    const { base, origin } = await start();
    const res = await post(`${base}/api/plan`, origin, { ticketKey: 'nope', comment: 'hi' });
    expect(res.status).toBe(400);
  });

  it('refuses a plan that is not JSON', async () => {
    const { base, origin } = await start();
    const res = await post(`${base}/api/plan`, origin, { ticketKey: 'PROJ-123', comment: 'hi' }, 'text/plain');
    expect(res.status).toBe(415);
  });

  it('writes nothing for a plan that is never applied', async () => {
    const { base, origin, jira } = await start();
    const res = await post(`${base}/api/plan`, origin, { ticketKey: 'PROJ-123', comment: 'Looks good' });
    const plan = await res.json() as { planId: string; preview: string };
    expect(plan.preview).toContain('Looks good');
    expect(jira.addCommentCalls).toEqual([]);
  });

  it('applies a plan once and refuses the same plan a second time', async () => {
    const { base, origin, jira } = await start();
    const { planId } = await (await post(`${base}/api/plan`, origin, { ticketKey: 'PROJ-123', comment: 'Looks good' })).json() as { planId: string };
    const first = await post(`${base}/api/apply`, origin, { planId });
    expect(first.status).toBe(200);
    const second = await post(`${base}/api/apply`, origin, { planId });
    expect(second.status).toBe(409);
    expect(jira.addCommentCalls).toEqual([{ issueKey: 'PROJ-123', body: 'Looks good' }]);
  });

  it('records the board path for the report with the canvas key masked', async () => {
    const { base } = await start();
    const canvasKey = base.split('/').pop() as string;
    await fetch(`${base}/api/tickets`);
    const stats = server?.stats();
    expect(stats?.recentPaths).toContain('/[key]/api/tickets');
    expect(JSON.stringify(stats)).not.toContain(canvasKey);
  });

  it('answers 404 for an unknown board path', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/api/nothing`)).status).toBe(404);
  });
});
