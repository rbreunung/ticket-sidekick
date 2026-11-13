import { describe, it, expect } from 'vitest';
import { asBoardPanelState, boardPageUrl, boardPanelHtml, boardUnavailableHtml } from '../boards/boardPanelHtml';

// A board's editor tab: a frame around the board page on the extension's local server.

const state = { kind: 'security-report', id: 'a'.repeat(24), title: 'Security report: PROJ' };

describe('a board\'s editor tab', () => {
  it('frames the board page of its session on this computer', () => {
    const url = boardPageUrl(50123, 'KEY', 'security-report', state.id);
    expect(url).toBe(`http://127.0.0.1:50123/KEY/board/security-report/?s=${state.id}`);
    const html = boardPanelHtml({ url, port: 50123, nonce: 'n1', state });
    expect(html).toContain(`<iframe src="${url}"`);
    expect(html).toContain('<title>Security report: PROJ</title>');
  });

  it('lets nothing load but that frame, from the server\'s current port', () => {
    const html = boardPanelHtml({ url: boardPageUrl(50123, 'KEY', 'ticket-list', state.id), port: 50123, nonce: 'n1', state });
    expect(html).toContain("default-src 'none'; frame-src http://127.0.0.1:50123; style-src 'nonce-n1'; script-src 'nonce-n1'");
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('<script nonce="n1">');
  });

  it('opens the sessions board without a session', () => {
    expect(boardPageUrl(50123, 'KEY', 'sessions', '')).toBe('http://127.0.0.1:50123/KEY/board/sessions/');
  });

  it('stores which session it shows, so VS Code can hand it back after a restart', () => {
    const html = boardPanelHtml({ url: 'http://127.0.0.1:1/k/board/security-report/', port: 1, nonce: 'n', state });
    expect(html).toContain(`acquireVsCodeApi().setState(${JSON.stringify(state)});`);
  });

  it('keeps a title with markup in it as text', () => {
    const hostile = { ...state, title: 'Tickets: filter "</script><img src=x onerror=alert(1)>"' };
    const html = boardPanelHtml({ url: 'http://127.0.0.1:1/k/board/ticket-list/', port: 1, nonce: 'n', state: hostile });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('</script><');
  });

  it('says why when the local server is not running, and still remembers its session', () => {
    const html = boardUnavailableHtml({ nonce: 'n', state, reason: 'The local server is not running.' });
    expect(html).toContain('<p>The local server is not running.</p>');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('setState(');
  });
});

describe('a tab VS Code brings back', () => {
  it('is accepted with the state the tab stored', () => {
    expect(asBoardPanelState(state)).toEqual(state);
    expect(asBoardPanelState({ kind: 'sessions', id: '', title: 'Stored sessions' })).toEqual({ kind: 'sessions', id: '', title: 'Stored sessions' });
  });

  it('is refused when the stored state is not a board\'s', () => {
    expect(asBoardPanelState(undefined)).toBeUndefined();
    expect(asBoardPanelState({ kind: '../x', id: '', title: 't' })).toBeUndefined();
    expect(asBoardPanelState({ kind: 'ticket-list', id: '../../etc', title: 't' })).toBeUndefined();
    expect(asBoardPanelState({ kind: 'ticket-list', id: 'abc' })).toBeUndefined();
  });
});
