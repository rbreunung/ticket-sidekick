import { describe, it, expect } from 'vitest';
import { ticketListJiraDeps } from '../boards/ticketList/jiraDeps';
import type { IJiraClient, JiraIssue } from '../jira/IJiraClient';
import type { JiraAccess } from '../mcp/jiraTools/jiraAccess';

// What the ticket list board reads from and writes to Jira, against a stub client.

function issue(n: number, status = 'Open'): JiraIssue {
  return { id: String(n), key: `PROJ-${n}`, fields: { summary: `Ticket ${n}`, status: { name: status }, issuetype: { name: 'Bug' }, assignee: { displayName: 'Ada' }, priority: { name: 'High' }, updated: `t${n}` } } as unknown as JiraIssue;
}

function deps(client: Partial<IJiraClient>, configured = true) {
  const access = (configured
    ? { configured: true, config: { baseUrl: 'https://jira.example.com', token: 'x' }, client }
    : { configured: false, config: {} }) as unknown as JiraAccess;
  return ticketListJiraDeps({ getJira: async () => access, workspaceFolder: () => undefined, now: () => 1 });
}

describe('reading a ticket list from Jira', () => {
  it('reads page after page up to the limit and says when more match', async () => {
    const calls: number[] = [];
    const d = deps({
      searchJql: async (_jql: string, max?: number, startAt?: number) => {
        calls.push(startAt ?? 0);
        const from = startAt ?? 0;
        return { issues: Array.from({ length: Math.min(max ?? 50, 250 - from) }, (_, i) => issue(from + i + 1)), total: 250 };
      },
    } as never);
    const all = await d.search('project = PROJ', 300);
    expect(all.rows).toHaveLength(250);
    expect(all.truncated).toBe(false);
    expect(all.rows[0]).toEqual({ key: 'PROJ-1', summary: 'Ticket 1', status: 'Open', issueType: 'Bug', assignee: 'Ada', priority: 'High', updated: 't1' });
    const capped = await d.search('project = PROJ', 120);
    expect(capped.rows).toHaveLength(120);
    expect(capped.truncated).toBe(true);
    expect(calls.slice(0, 3)).toEqual([0, 100, 200]);
  });

  it('words a failed search as status and short reason, without Jira\'s response body', async () => {
    const d = deps({ searchJql: async () => { throw Object.assign(new Error('<html>secret</html>'), { status: 400 }); } } as never);
    await expect(d.search('nonsense', 10)).rejects.toThrow(/^Jira answered HTTP 400/);
  });

  it('reads a ticket as it is now, and reports one that is gone as gone', async () => {
    const d = deps({
      getIssue: async (key: string) => {
        if (key === 'PROJ-9') throw Object.assign(new Error('not found'), { status: 404 });
        return issue(1, 'In Review');
      },
    } as never);
    expect(await d.readTicket('PROJ-1')).toEqual({ status: 'In Review', updated: 't1' });
    expect(await d.readTicket('PROJ-9')).toBeUndefined();
  });
});

describe('a saved filter', () => {
  const filters = [{ id: '7', name: 'My bugs', jql: 'type = Bug' }, { id: '8', name: 'My bugs old', jql: 'type = Bug AND created < -90d' }];
  const client = {
    getFilterById: async (id: string) => filters.find(f => f.id === id)!,
    searchFiltersByName: async (name: string) => filters.filter(f => f.name.toLowerCase().includes(name.toLowerCase())),
  } as never;

  it('is found by id and by a name that matches one filter', async () => {
    expect(await deps(client).resolveFilter('7')).toEqual(filters[0]);
    expect(await deps(client).resolveFilter('old')).toEqual(filters[1]);
  });

  it('is refused with the candidates when several match, and when none does', async () => {
    expect(await deps(client).resolveFilter('my bugs')).toMatch(/several saved filters match.*My bugs \(id 7\).*My bugs old \(id 8\)/);
    expect(await deps(client).resolveFilter('zzz')).toBe('no saved filter matches "zzz".');
  });
});

describe('moving a ticket', () => {
  it('takes the direct transition and sets the resolution', async () => {
    const executed: unknown[] = [];
    const d = deps({
      getIssue: async () => issue(1, 'Open'),
      getTransitions: async () => [{ id: '31', name: 'Close', to: { name: 'Closed' } }],
      executeTransition: async (...args: unknown[]) => { executed.push(args); },
    } as never);
    expect(await d.move('PROJ-1', 'closed', 'Fixed')).toBe('moved to Closed');
    expect(executed).toEqual([['PROJ-1', '31', { resolution: { name: 'Fixed' } }]]);
  });

  it('says which statuses can be reached when there is no path', async () => {
    const d = deps({
      getIssue: async () => issue(1, 'Open'),
      getTransitions: async () => [{ id: '11', name: 'Start', to: { name: 'In Progress' } }],
    } as never);
    await expect(d.move('PROJ-1', 'Closed')).rejects.toThrow('no path from Open to Closed. It can reach: In Progress.');
  });
});

describe('without Jira set up', () => {
  it('says so', async () => {
    const d = deps({}, false);
    expect(await d.jiraConfigured()).toBe(false);
    expect(await d.baseUrl()).toBeUndefined();
  });
});

describe('setting a field from the board', () => {
  it('sets a sprint by its name and a custom list field from comma-separated values, like the field tool', async () => {
    const updates: unknown[] = [];
    const d = deps({
      getFields: async () => [
        { id: 'customfield_10020', name: 'Sprint', schema: { type: 'array', items: 'json', custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
        { id: 'customfield_10501', name: 'Category', schema: { type: 'array', items: 'option' } },
      ],
      findSprints: async () => [{ id: 77, name: 'Sprint 12', state: 'active' }],
      getEditMeta: async () => ({ customfield_10501: { schema: { type: 'array', items: 'option' }, allowedValues: [{ id: '1', value: 'A' }] } }),
      updateIssue: async (key: string, fields: unknown) => { updates.push([key, fields]); },
    } as never);
    await d.setField('PROJ-1', 'Sprint', 'Sprint 12');
    await d.setField('PROJ-1', 'Category', 'A, B');
    expect(updates).toEqual([
      ['PROJ-1', { customfield_10020: 77 }],
      ['PROJ-1', { customfield_10501: [{ value: 'A' }, { value: 'B' }] }],
    ]);
  });

  it('says so and writes nothing when no field has the name', async () => {
    const d = deps({ getFields: async () => [], updateIssue: async () => { throw new Error('must not write'); } } as never);
    await expect(d.setField('PROJ-1', 'Nope', 'x')).rejects.toThrow('No field named "Nope" was found. Nothing was changed.');
  });
});
