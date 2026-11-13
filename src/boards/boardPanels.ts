import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { SessionManager } from '../sessions/sessionManager';
import { asBoardPanelState, boardPageUrl, boardPanelHtml, boardUnavailableHtml, type BoardPanelState } from './boardPanelHtml';
import { SESSIONS_BOARD } from './boardRoutes';

// Boards as editor tabs: the extension opens a webview tab whose only content is a frame around
// the board page on its local server. An agent asks for a board through a tool, a person through
// the Command Palette; nothing here needs a canvas, a plugin or the Copilot runtime. VS Code
// restores the tabs after a restart and each one finds its session again by its id.

export const BOARD_VIEW_TYPE = 'ticketSidekick.board';

export const NO_SERVER_REASON =
  'Ticket Sidekick\'s local server is not running. It runs while 127.0.0.1 is in the http.noProxy setting; the board appears here once it does.';

export type BoardOpened = { ok: true; title: string } | { ok: false; reason: string };

export interface ServerAccess {
  port: number;
  canvasKey: string;
}

export class BoardPanels {
  private readonly panels = new Map<string, { panel: vscode.WebviewPanel; state: BoardPanelState }>();
  private access: () => ServerAccess | undefined = () => undefined;

  constructor(private readonly manager: SessionManager, private readonly kinds: readonly string[]) {}

  /** Where the local server listens now; set once the server controller exists. */
  setAccess(access: () => ServerAccess | undefined): void {
    this.access = access;
  }

  private key(state: BoardPanelState): string {
    return `${state.kind}:${state.id}`;
  }

  private render(panel: vscode.WebviewPanel, state: BoardPanelState): void {
    const nonce = randomBytes(16).toString('hex');
    const access = this.access();
    panel.title = state.title;
    panel.webview.html = access
      ? boardPanelHtml({ url: boardPageUrl(access.port, access.canvasKey, state.kind, state.id), port: access.port, nonce, state })
      : boardUnavailableHtml({ nonce, state, reason: NO_SERVER_REASON });
  }

  private track(panel: vscode.WebviewPanel, state: BoardPanelState): void {
    const key = this.key(state);
    this.panels.set(key, { panel, state });
    panel.onDidDispose(() => {
      if (this.panels.get(key)?.panel === panel) this.panels.delete(key);
    });
    this.render(panel, state);
  }

  /** Draws every open board again: the server's port and key change whenever it starts. */
  refreshAll(): void {
    for (const { panel, state } of this.panels.values()) this.render(panel, state);
  }

  /** Opens the board for a request, or brings its tab forward when it is open already. */
  async open(kind: string, input: unknown): Promise<BoardOpened> {
    let state: BoardPanelState;
    if (kind === SESSIONS_BOARD) {
      state = { kind, id: '', title: 'Stored sessions' };
    } else {
      if (!this.kinds.includes(kind)) return { ok: false, reason: 'there is no board of that name.' };
      const opened = await this.manager.open(kind, input ?? {});
      if (!opened.ok) return opened;
      state = { kind, id: opened.id, title: opened.title };
    }
    if (!this.access()) return { ok: false, reason: NO_SERVER_REASON };
    const existing = this.panels.get(this.key(state));
    if (existing) {
      existing.panel.reveal();
      return { ok: true, title: state.title };
    }
    const panel = vscode.window.createWebviewPanel(BOARD_VIEW_TYPE, state.title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.track(panel, state);
    return { ok: true, title: state.title };
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
        panel.webview.options = { enableScripts: true };
        this.track(panel, state);
      },
    };
  }
}
