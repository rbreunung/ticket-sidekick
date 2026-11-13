import * as vscode from 'vscode';
import type { SessionManager } from '../sessions/sessionManager';
import { answerBoardRequest, asBoardRequest, SESSIONS_BOARD, type BoardHost } from './boardMessages';
import { asBoardPanelState, boardPanelHtml, type BoardPanelState } from './boardPanelHtml';

// Boards as editor tabs. The extension opens a webview tab, writes its document and answers the
// page's requests over VS Code's message channel. An agent asks for a board through the
// `jira_open_board` tool, a person through the Command Palette. VS Code restores the tabs after a
// restart and each one finds its session again by its id.

export const BOARD_VIEW_TYPE = 'ticketSidekick.board';

export type BoardOpened = { ok: true; title: string } | { ok: false; reason: string };

/** Counts for the tests that drive a real VS Code: how many tabs are open and how many page requests were answered. */
export interface BoardStats {
  openTabs: number;
  requestsAnswered: number;
}

export class BoardPanels implements BoardHost {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private requestsAnswered = 0;

  constructor(
    private readonly manager: SessionManager,
    private readonly kinds: readonly string[],
    /** The folder the board pages are shipped in. */
    private readonly pagesRoot: vscode.Uri,
    private readonly onError: (message: string) => void,
  ) {}

  stats(): BoardStats {
    return { openTabs: this.panels.size, requestsAnswered: this.requestsAnswered };
  }

  private key(state: BoardPanelState): string {
    return `${state.kind}:${state.id}`;
  }

  private options(): vscode.WebviewOptions {
    return { enableScripts: true, localResourceRoots: [this.pagesRoot] };
  }

  private show(panel: vscode.WebviewPanel, state: BoardPanelState): void {
    const key = this.key(state);
    this.panels.set(key, panel);
    const asset = (...parts: string[]) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.pagesRoot, ...parts)).toString();
    panel.title = state.title;
    panel.webview.options = this.options();
    const listener = panel.webview.onDidReceiveMessage(async (raw: unknown) => {
      const request = asBoardRequest(raw);
      if (!request) return;
      const reply = await answerBoardRequest(this.manager, state, request, this, this.onError);
      this.requestsAnswered++;
      // The tab may have been closed while a state request was waiting for a change.
      if (this.panels.get(key) === panel) void panel.webview.postMessage(reply);
    });
    panel.onDidDispose(() => {
      listener.dispose();
      if (this.panels.get(key) === panel) this.panels.delete(key);
    });
    panel.webview.html = boardPanelHtml({
      cspSource: panel.webview.cspSource,
      assets: {
        style: asset('shared', 'board.css'),
        elements: asset('shared', 'vscode-elements.js'),
        page: asset(state.kind, 'page.js'),
      },
      state,
    });
  }

  private reveal(state: BoardPanelState): void {
    const existing = this.panels.get(this.key(state));
    if (existing) {
      existing.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(BOARD_VIEW_TYPE, state.title, vscode.ViewColumn.Active, { ...this.options(), retainContextWhenHidden: true });
    this.show(panel, state);
  }

  /** Opens the board for a request, or brings its tab forward when it is open already. */
  async open(kind: string, input: unknown): Promise<BoardOpened> {
    if (kind === SESSIONS_BOARD) {
      this.reveal({ kind, id: '', title: 'Stored sessions' });
      return { ok: true, title: 'Stored sessions' };
    }
    if (!this.kinds.includes(kind)) return { ok: false, reason: 'there is no board of that name.' };
    const opened = await this.manager.open(kind, input ?? {});
    if (!opened.ok) return opened;
    this.reveal({ kind, id: opened.id, title: opened.title });
    return { ok: true, title: opened.title };
  }

  /** Opens the board of a session that is stored already, as the sessions board's Reopen asks. */
  async openStored(kind: string, id: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.kinds.includes(kind)) return { ok: false, reason: 'there is no board of that name.' };
    const row = (await this.manager.list()).find(s => s.kind === kind && s.id === id);
    if (!row) return { ok: false, reason: 'this session is no longer stored.' };
    this.reveal({ kind, id, title: row.title });
    return { ok: true };
  }

  /** VS Code calls this for each board tab it brings back after a restart. */
  serializer(): vscode.WebviewPanelSerializer {
    return {
      deserializeWebviewPanel: async (panel, raw) => {
        const state = asBoardPanelState(raw);
        if (!state || (state.kind !== SESSIONS_BOARD && !this.kinds.includes(state.kind))) {
          panel.dispose();
          return;
        }
        this.show(panel, state);
      },
    };
  }
}
