import { describe, it, expect } from 'vitest';
import { checkDefaultProject, defaultProjectWarning, type DefaultProjectDeps } from '../services/defaultProjectCheck';
import { JiraApiError } from '../utils/apiError';

// The check of ticketSidekick.jira.defaultProject at start and after a change: a value that is not
// a project key, or a project Jira does not have, gives a warning; anything Jira cannot answer
// gives none, since it says nothing about the setting.

function deps(opts: { configured?: boolean; projects?: string[]; error?: Error } = {}): DefaultProjectDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    isJiraConfigured: async () => opts.configured ?? true,
    getProject: async key => {
      asked.push(key);
      if (opts.error) throw opts.error;
      if (!(opts.projects ?? []).includes(key)) throw new JiraApiError('Not found', 404, `https://jira.example.com/rest/api/2/project/${key}`);
      return { key };
    },
  };
}

describe('checking the default project', () => {
  it('is quiet when no default project is set', async () => {
    const d = deps();
    expect(await checkDefaultProject('', d)).toEqual({ kind: 'unset' });
    expect(await checkDefaultProject(undefined, d)).toEqual({ kind: 'unset' });
    expect(d.asked).toEqual([]);
  });

  it('accepts a project Jira has, in any letter case', async () => {
    const check = await checkDefaultProject(' proj ', deps({ projects: ['PROJ'] }));
    expect(check).toEqual({ kind: 'ok', project: 'PROJ' });
    expect(defaultProjectWarning(check)).toBeUndefined();
  });

  it('warns about a value that is not a project key, without asking Jira', async () => {
    const d = deps();
    const check = await checkDefaultProject('PROJ-1', d);
    expect(check).toEqual({ kind: 'malformed', value: 'PROJ-1' });
    expect(d.asked).toEqual([]);
    expect(defaultProjectWarning(check)).toContain('"PROJ-1" (ticketSidekick.jira.defaultProject) is not a Jira project key');
  });

  it('warns when Jira has no such project', async () => {
    const check = await checkDefaultProject('PORJ', deps({ projects: ['PROJ'] }));
    expect(check).toEqual({ kind: 'not-found', project: 'PORJ' });
    expect(defaultProjectWarning(check)).toContain('Jira has no project PORJ');
  });

  it('does not warn while Jira is not set up, or when Jira cannot answer', async () => {
    const notSetUp = await checkDefaultProject('PROJ', deps({ configured: false }));
    expect(notSetUp).toEqual({ kind: 'unchecked', project: 'PROJ', reason: 'jira-not-configured' });
    const refused = await checkDefaultProject('PROJ', deps({ error: new JiraApiError('Unauthorized', 401, 'https://jira.example.com') }));
    expect(refused).toEqual({ kind: 'unchecked', project: 'PROJ', reason: 'jira-error', status: 401 });
    const offline = await checkDefaultProject('PROJ', deps({ error: new Error('getaddrinfo ENOTFOUND') }));
    expect(offline).toMatchObject({ kind: 'unchecked', reason: 'jira-error' });
    for (const check of [notSetUp, refused, offline]) expect(defaultProjectWarning(check)).toBeUndefined();
  });

  it('keeps control characters and quotes of a pasted value out of the warning, and shortens it', () => {
    const warning = defaultProjectWarning({ kind: 'malformed', value: `a"b\n${'x'.repeat(80)}` })!;
    expect(warning).not.toContain('\n');
    expect(warning).toContain('"ab');
    expect(warning).toContain('…"');
  });
});
