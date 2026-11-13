import { describe, it, expect } from 'vitest';
import { asBoardPanelState, boardPanelHtml } from '../boards/boardPanelHtml';

// A board's editor tab: a document the extension writes, loading the board page from the
// extension's own files.

const state = { kind: 'security-report', id: 'a'.repeat(24), title: 'Security report: PROJ' };
const assets = {
  style: 'https://file+.vscode-resource.vscode-cdn.net/ext/out/board-pages/shared/board.css',
  elements: 'https://file+.vscode-resource.vscode-cdn.net/ext/out/board-pages/shared/vscode-elements.js',
  page: 'https://file+.vscode-resource.vscode-cdn.net/ext/out/board-pages/security-report/page.js',
};
const cspSource = 'https://*.vscode-cdn.net';

describe('a board\'s editor tab', () => {
  it('loads the board\'s page script, the shared style and the VS Code Elements bundle', () => {
    const html = boardPanelHtml({ cspSource, assets, state });
    expect(html).toContain(`<script type="module" src="${assets.page}"></script>`);
    expect(html).toContain(`<script type="module" src="${assets.elements}"></script>`);
    expect(html).toContain(`<link rel="stylesheet" href="${assets.style}">`);
    expect(html).toContain('<title>Security report: PROJ</title>');
  });

  it('lets scripts load from the extension\'s own files only, runs no inline script and frames nothing', () => {
    const html = boardPanelHtml({ cspSource, assets, state });
    expect(html).toContain(`default-src &#39;none&#39;; script-src ${cspSource}; style-src ${cspSource} &#39;unsafe-inline&#39;; font-src ${cspSource}; img-src ${cspSource} data:`);
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('127.0.0.1');
  });

  it('tells the page which board and session it shows', () => {
    const html = boardPanelHtml({ cspSource, assets, state });
    expect(html).toContain(`<main id="root" data-kind="security-report" data-session="${state.id}" data-title="Security report: PROJ"></main>`);
  });

  it('opens the sessions board without a session', () => {
    const html = boardPanelHtml({ cspSource, assets, state: { kind: 'sessions', id: '', title: 'Stored sessions' } });
    expect(html).toContain('data-kind="sessions" data-session=""');
  });

  it('keeps a title with markup in it as text', () => {
    const html = boardPanelHtml({ cspSource, assets, state: { ...state, title: 'Tickets: "<script>alert(1)</script>"' } });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('a board tab VS Code restores after a restart', () => {
  it('is accepted in its known shape', () => {
    expect(asBoardPanelState(state)).toEqual(state);
    expect(asBoardPanelState({ kind: 'sessions', id: '', title: 'Stored sessions' })).toEqual({ kind: 'sessions', id: '', title: 'Stored sessions' });
  });

  it('is dropped when what was stored is not a board', () => {
    expect(asBoardPanelState(undefined)).toBeUndefined();
    expect(asBoardPanelState({ kind: '../x', id: '', title: 't' })).toBeUndefined();
    expect(asBoardPanelState({ kind: 'security-report', id: '../../x', title: 't' })).toBeUndefined();
    expect(asBoardPanelState({ kind: 'security-report', id: 'abc' })).toBeUndefined();
  });
});
