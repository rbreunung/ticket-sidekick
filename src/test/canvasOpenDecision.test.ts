import { describe, it, expect } from 'vitest';
import { asBoardOpenCheck, BOARD_CANVASES, OPEN_STATUS, openAnswer, restoreAction, RESTORE_WAIT_MS } from '../canvas/openDecision';
import type { WindowChoice } from '../canvas/selectWindow';

// What the agent learns when it opens a board canvas: "opened" with the page address going to the
// canvas host, or the reason. Never board data.

const report = BOARD_CANVASES.find(c => c.id === 'security-report')!;
const sessions = BOARD_CANVASES.find(c => c.id === 'sessions')!;
const selected: WindowChoice = { kind: 'selected', note: { pid: 1, port: 50123, canvasKey: 'k'.repeat(64), workspaceFolders: ['/work/app'], startedAt: 0 } as never };
const ID = 'a'.repeat(24);

describe('opening a board canvas', () => {
  it('returns the page address of the board\'s session and says it opened', () => {
    const answer = openAnswer(report, selected, { ok: true, id: ID, title: 'Security report: PROJ' });
    expect(answer.url).toBe(`http://127.0.0.1:50123/${'k'.repeat(64)}/board/security-report/?s=${ID}`);
    expect(answer.title).toBe('Security report: PROJ');
    expect(answer.status).toBe('Opened: Security report: PROJ.');
  });

  it('opens the sessions board without a session', () => {
    const answer = openAnswer(sessions, selected, { ok: true, id: '', title: 'Stored sessions' });
    expect(answer.url).toBe(`http://127.0.0.1:50123/${'k'.repeat(64)}/board/sessions/`);
  });

  it('passes the window\'s reason on and opens nothing', () => {
    const answer = openAnswer(report, selected, { ok: false, reason: 'no project was named.' });
    expect(answer.url).toBeUndefined();
    expect(answer.status).toBe('Not opened: no project was named.');
  });

  it('says why when no window serves the chat', () => {
    expect(openAnswer(report, { kind: 'not-running' }, undefined)).toEqual({ title: 'Security report', status: OPEN_STATUS.notRunning });
    expect(openAnswer(report, { kind: 'no-match' }, undefined)).toEqual({ title: 'Security report', status: OPEN_STATUS.noMatch });
    expect(openAnswer(report, selected, undefined).status).toBe(OPEN_STATUS.unreachable);
  });
});

describe('what a window may answer', () => {
  it('accepts an opened session and a refusal', () => {
    expect(asBoardOpenCheck({ ok: true, id: ID, title: 'Security report: PROJ' })).toEqual({ ok: true, id: ID, title: 'Security report: PROJ' });
    expect(asBoardOpenCheck({ ok: false, reason: 'Jira is not set up.' })).toEqual({ ok: false, reason: 'Jira is not set up.' });
  });

  it('refuses anything else, so no other text reaches the agent', () => {
    expect(asBoardOpenCheck(undefined)).toBeUndefined();
    expect(asBoardOpenCheck({ ok: true, id: '../../etc', title: 'x' })).toBeUndefined();
    expect(asBoardOpenCheck({ ok: true, id: ID })).toBeUndefined();
    expect(asBoardOpenCheck({ ok: false })).toBeUndefined();
    expect(asBoardOpenCheck({ ok: 'yes', id: ID, title: 'x' })).toBeUndefined();
  });

  it('flattens and caps the text it passes on', () => {
    const check = asBoardOpenCheck({ ok: false, reason: `line one\nline two ${'x'.repeat(400)}` });
    expect(check && !check.ok && check.reason.includes('\n')).toBe(false);
    expect(check && !check.ok && check.reason.length).toBe(300);
  });
});

describe('a canvas brought back after a restart', () => {
  it('is kept when its page still answers', () => {
    expect(restoreAction({ pageAnswers: true, chatWindowRunning: false, waitedMs: 0 })).toBe('keep');
  });
  it('is reopened once the chat\'s window runs again', () => {
    expect(restoreAction({ pageAnswers: false, chatWindowRunning: true, waitedMs: 5000 })).toBe('reopen');
  });
  it('waits for the window, then is closed', () => {
    expect(restoreAction({ pageAnswers: false, chatWindowRunning: false, waitedMs: RESTORE_WAIT_MS - 1 })).toBe('wait');
    expect(restoreAction({ pageAnswers: false, chatWindowRunning: false, waitedMs: RESTORE_WAIT_MS })).toBe('close');
  });
});

describe('the canvases the agent is offered', () => {
  it('have distinct ids and tell the agent which instance id to use', () => {
    expect(new Set(BOARD_CANVASES.map(c => c.id)).size).toBe(BOARD_CANVASES.length);
    for (const canvas of BOARD_CANVASES) expect(canvas.description).toContain('instance id');
  });
});
