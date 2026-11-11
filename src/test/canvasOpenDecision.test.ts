import { describe, it, expect } from 'vitest';
import { selectWindow } from '../canvas/selectWindow';
import { instanceIdFor, OPEN_STATUS, openAnswer, projectFromInput, restoreAction, RESTORE_WAIT_MS } from '../canvas/openDecision';
import { checkOpen } from '../canvas/openCheck';
import type { WindowNote } from '../canvas/windowNotes';

// What the canvas program answers when the agent opens the security report, and what it does with
// a canvas the runtime brought back after a restart.

const KEY_A = 'a'.repeat(43);
const KEY_B = 'b'.repeat(43);
const windowA: WindowNote = { pid: 1, port: 50001, canvasKey: KEY_A, workspaceFolders: ['/work/payments'], startedAt: '2026-11-11T10:00:00Z' };
const windowB: WindowNote = { pid: 2, port: 50002, canvasKey: KEY_B, workspaceFolders: ['/work/portal'], startedAt: '2026-11-11T10:00:00Z' };
const alive = () => true;

describe('choosing the window that serves a chat', () => {
  it('picks the window whose workspace holds the chat\'s folder', () => {
    expect(selectWindow([windowA, windowB], '/work/payments/api', alive, 'linux')).toEqual({ kind: 'selected', note: windowA });
    expect(selectWindow([windowA, windowB], '/work/portal', alive, 'linux')).toEqual({ kind: 'selected', note: windowB });
  });

  it('prefers the more specific folder when two windows hold the chat\'s folder', () => {
    const nested: WindowNote = { ...windowB, workspaceFolders: ['/work/payments/api'] };
    expect(selectWindow([windowA, nested], '/work/payments/api/src', alive, 'linux')).toEqual({ kind: 'selected', note: nested });
  });

  it('chooses no window when none holds the chat\'s folder, or the chat has none', () => {
    expect(selectWindow([windowA, windowB], '/home/dev/scratch', alive, 'linux')).toEqual({ kind: 'no-match' });
    expect(selectWindow([windowA], undefined, alive, 'linux')).toEqual({ kind: 'no-match' });
  });

  it('does not take a folder that only shares a name prefix', () => {
    expect(selectWindow([windowA], '/work/payments-old', alive, 'linux')).toEqual({ kind: 'no-match' });
  });

  it('ignores the note of a window whose process has ended', () => {
    expect(selectWindow([windowA], '/work/payments', () => false, 'linux')).toEqual({ kind: 'not-running' });
  });

  it('matches folders without regard to case on Windows', () => {
    const win: WindowNote = { ...windowA, workspaceFolders: ['C:\\Work\\Payments'] };
    expect(selectWindow([win], 'c:\\work\\payments\\api', alive, 'win32')).toEqual({ kind: 'selected', note: win });
    expect(selectWindow([windowA], '/WORK/PAYMENTS', alive, 'linux')).toEqual({ kind: 'no-match' });
  });
});

describe('the open answer', () => {
  it('gives the chat\'s window address with the project, and a status naming only the project', () => {
    const answer = openAnswer({ kind: 'selected', note: windowA }, { ok: true, project: 'PROJ' });
    expect(answer.url).toBe(`http://127.0.0.1:50001/${KEY_A}/security-report/?project=PROJ`);
    expect(answer.title).toBe('Security report: PROJ');
    expect(answer.status).toBe('Opened the security report for PROJ.');
  });

  it('gives no address and names the reason when the canvas cannot open', () => {
    expect(openAnswer({ kind: 'not-running' }, undefined)).toEqual({ title: 'Security report', status: OPEN_STATUS.notRunning });
    expect(openAnswer({ kind: 'no-match' }, undefined).status).toBe(OPEN_STATUS.noMatch);
    expect(openAnswer({ kind: 'selected', note: windowA }, { ok: false, reason: 'no-project' }).status).toBe(OPEN_STATUS.noProject);
    expect(openAnswer({ kind: 'selected', note: windowA }, { ok: false, reason: 'not-configured' }).status).toBe(OPEN_STATUS.notConfigured);
    expect(openAnswer({ kind: 'selected', note: windowA }, undefined).url).toBeUndefined();
  });

  it('never puts the canvas key into the status the agent sees', () => {
    for (const status of Object.values(OPEN_STATUS)) expect(status).not.toContain(KEY_A);
    expect(openAnswer({ kind: 'selected', note: windowA }, { ok: true, project: 'PROJ' }).status).not.toContain(KEY_A);
  });
});

describe('the project and instance id', () => {
  it('upper-cases a project key and refuses anything that is not one', () => {
    expect(projectFromInput({ project: ' proj ' })).toBe('PROJ');
    expect(projectFromInput({ project: 'PROJ AND 1=1' })).toBeUndefined();
    expect(projectFromInput({})).toBeUndefined();
    expect(projectFromInput(null)).toBeUndefined();
  });

  it('asks for one canvas per project, and one for a request without a project', () => {
    expect(instanceIdFor('PROJ')).toBe('security-report-PROJ');
    expect(instanceIdFor(undefined)).toBe('security-report');
  });
});

describe('the open check of a window', () => {
  const deps = (configured: boolean, defaultProject: string) => ({ isJiraConfigured: async () => configured, defaultProject: () => defaultProject });

  it('uses the project asked for, else the window\'s default project', async () => {
    expect(await checkOpen('proj', deps(true, 'OTHER'))).toEqual({ ok: true, project: 'PROJ' });
    expect(await checkOpen(null, deps(true, 'OTHER'))).toEqual({ ok: true, project: 'OTHER' });
  });

  it('says when no project is known or Jira is not set up', async () => {
    expect(await checkOpen(null, deps(true, ''))).toEqual({ ok: false, reason: 'no-project' });
    expect(await checkOpen('PROJ', deps(false, ''))).toEqual({ ok: false, reason: 'not-configured' });
  });
});

describe('a canvas brought back after a restart', () => {
  it('is kept while its page still answers', () => {
    expect(restoreAction({ pageAnswers: true, anyWindowRunning: true, waitedMs: 0 })).toBe('keep');
  });

  it('is reopened once a window\'s server runs, and waited for until then', () => {
    expect(restoreAction({ pageAnswers: false, anyWindowRunning: true, waitedMs: 5_000 })).toBe('reopen');
    expect(restoreAction({ pageAnswers: false, anyWindowRunning: false, waitedMs: 5_000 })).toBe('wait');
  });

  it('is closed when no window comes back within the wait', () => {
    expect(restoreAction({ pageAnswers: false, anyWindowRunning: false, waitedMs: RESTORE_WAIT_MS })).toBe('close');
  });
});
