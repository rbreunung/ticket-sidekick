import * as vscode from 'vscode';
import type { SessionManager } from '../sessions/sessionManager';
import { answerBoardRequest, asBoardRequest, SESSIONS_BOARD, type BoardHost } from './boardMessages';
import { asBoardPanelState, boardPanelHtml, type BoardPanelState } from './boardPanelHtml';
import type { ReportKind } from './import/recipe';
import { IMPORT_START_BOARD, IMPORT_START_TITLE, type ImportStartScreen } from './import/startScreen';
import { REVIEW_START_BOARD, REVIEW_START_TITLE, type ReviewStartScreen } from './review/startScreen';

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
  /** The message listener of each tab, replaced when the tab follows its session to another id. */
  private readonly listeners = new Map<vscode.WebviewPanel, vscode.Disposable>();
  private requestsAnswered = 0;

  constructor(
    private readonly manager: SessionManager,
    private readonly kinds: readonly string[],
    /** The folder the board pages are shipped in. */
    private readonly pagesRoot: vscode.Uri,
    private readonly onError: (message: string) => void,
    /** The import start screen: a tab without a session, like the stored sessions board. */
    readonly importStart?: ImportStartScreen,
    /** The native open dialog for an import's report file ("Pick the file again"). */
    private readonly pickReport?: (kind: ReportKind) => Promise<string | undefined>,
    /** The pull request review start screen: a tab without a session that asks for the link. */
    readonly reviewStart?: ReviewStartScreen,
  ) {}

  /** The system clipboard, for the review board's Copy. */
  async copyText(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
  }

  /**
   * Discuss in chat: Copilot Chat in agent mode with the prompt typed in, for the developer to add
   * a question and send. Below VS Code 1.99 the mode is ignored and chat opens in its current mode.
   */
  async openChat(prompt: string): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt, isPartialQuery: true, mode: 'agent' });
  }

  /** A web link from rendered Markdown; VS Code shows its own confirmation before it opens. */
  async openExternal(url: string): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(url, true));
  }

  pickReportFile(kind: ReportKind): Promise<string | undefined> {
    return this.pickReport ? this.pickReport(kind) : Promise.resolve(undefined);
  }

  /** Points the tab of a session that moved to another id at the new one: its page loads again with the new session. */
  async followSession(kind: string, fromId: string, toId: string, title: string): Promise<void> {
    const key = this.key({ kind, id: fromId, title });
    const panel = this.panels.get(key);
    if (!panel) return;
    this.panels.delete(key);
    this.show(panel, { kind, id: toId, title });
  }

  /** Closes the tab of a session that was discarded. */
  closeSession(kind: string, id: string): void {
    this.panels.get(this.key({ kind, id, title: '' }))?.dispose();
  }

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
    this.listeners.get(panel)?.dispose();
    const listener = panel.webview.onDidReceiveMessage(async (raw: unknown) => {
      const request = asBoardRequest(raw);
      if (!request) return;
      const reply = await answerBoardRequest(this.manager, state, request, this, this.onError);
      this.requestsAnswered++;
      // The tab may have been closed while a state request was waiting for a change.
      if (this.panels.get(key) === panel) void panel.webview.postMessage(reply);
    });
    this.listeners.set(panel, listener);
    panel.onDidDispose(() => {
      listener.dispose();
      if (this.listeners.get(panel) === listener) this.listeners.delete(panel);
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

  /**
   * The board tabs VS Code has brought back after a restart but not shown yet. It hands such a tab to
   * `deserializeWebviewPanel` only when the tab is first shown, so until then the extension has no panel
   * for it; the tab list still has it. A title no live panel has is what tells the two apart.
   */
  private unrestoredTabs(title: string | undefined): vscode.Tab[] {
    if (!title || [...this.panels.values()].some(panel => panel.title === title)) return [];
    const groups = vscode.window.tabGroups?.all ?? [];
    return groups.flatMap(group => group.tabs)
      .filter(tab => tab.label === title && tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(BOARD_VIEW_TYPE));
  }

  /** Whether the board's session has a tab, shown or waiting to be restored. */
  private hasTab(kind: string, id: string, title: string | undefined): boolean {
    return this.panels.has(this.key({ kind, id, title: '' })) || this.unrestoredTabs(title).length > 0;
  }

  private reveal(state: BoardPanelState): void {
    const existing = this.panels.get(this.key(state));
    if (existing) {
      existing.reveal();
      return;
    }
    // A tab waiting to be restored is replaced by the new one, so the board is not open twice.
    const waiting = this.unrestoredTabs(state.title);
    if (waiting.length > 0) void vscode.window.tabGroups.close(waiting);
    const panel = vscode.window.createWebviewPanel(BOARD_VIEW_TYPE, state.title, vscode.ViewColumn.Active, { ...this.options(), retainContextWhenHidden: true });
    this.show(panel, state);
  }

  /** Opens the board for a request, or brings its tab forward when it is open already. */
  async open(kind: string, input: unknown): Promise<BoardOpened> {
    if (kind === SESSIONS_BOARD) {
      this.reveal({ kind, id: '', title: 'Stored sessions' });
      return { ok: true, title: 'Stored sessions' };
    }
    if (kind === IMPORT_START_BOARD) {
      if (!this.importStart) return { ok: false, reason: 'there is no board of that name.' };
      this.importStart.prefill(input);
      // Asked for loaded (the open-board tool): the import board when nothing is missing, the start screen otherwise.
      if ((input as { openWhenReady?: unknown } | null | undefined)?.openWhenReady === true) {
        const loaded = await this.importStart.openIfReady();
        if (loaded.opened) return { ok: true, title: loaded.title ?? 'Jira Import Board' };
      }
      this.reveal({ kind, id: '', title: IMPORT_START_TITLE });
      return { ok: true, title: IMPORT_START_TITLE };
    }
    if (kind === REVIEW_START_BOARD) {
      if (!this.reviewStart) return { ok: false, reason: 'there is no board of that name.' };
      this.reveal({ kind, id: '', title: REVIEW_START_TITLE });
      return { ok: true, title: REVIEW_START_TITLE };
    }
    if (!this.kinds.includes(kind)) return { ok: false, reason: 'there is no board of that name.' };
    // A board that opens fresh keeps its session only while its tab is open; otherwise it starts clean.
    const titles = new Map((await this.manager.list()).map(row => [row.id, row.title]));
    const opened = await this.manager.open(kind, input ?? {}, { hasTab: id => this.hasTab(kind, id, titles.get(id)) });
    if (!opened.ok) return opened;
    this.reveal({ kind, id: opened.id, title: opened.title });
    return { ok: true, title: opened.title };
  }

  /** Opens the board of a session that is stored already, as the sessions board's Reopen asks. */
  async openStored(kind: string, id: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.kinds.includes(kind)) return { ok: false, reason: 'there is no board of that name.' };
    const row = (await this.manager.list()).find(s => s.kind === kind && s.id === id);
    if (!row) return { ok: false, reason: 'this session is no longer stored.' };
    // A board that opens fresh starts over from its stored list when no tab of it is open.
    if (this.manager.opensFresh(kind) && !this.hasTab(kind, id, row.title)) await this.manager.startOver(kind, id);
    this.reveal({ kind, id, title: row.title });
    return { ok: true };
  }

  /** VS Code calls this for each board tab it brings back after a restart. */
  serializer(): vscode.WebviewPanelSerializer {
    return {
      deserializeWebviewPanel: async (panel, raw) => {
        const state = asBoardPanelState(raw);
        const sessionless = state?.kind === SESSIONS_BOARD || (state?.kind === IMPORT_START_BOARD && this.importStart !== undefined)
          || (state?.kind === REVIEW_START_BOARD && this.reviewStart !== undefined);
        if (!state || (!sessionless && !this.kinds.includes(state.kind))) {
          panel.dispose();
          return;
        }
        this.show(panel, state);
      },
    };
  }
}
