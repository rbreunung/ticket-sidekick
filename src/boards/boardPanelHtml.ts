// What a board's editor tab holds: a frame around the board page that the extension's local server
// serves. The page is the same one a canvas would show, so nothing about a board depends on which
// of the two hosts it. Pure, so the markup and its content policy are tested without VS Code.

export interface BoardPanelState {
  kind: string;
  /** The session the tab shows; empty for the sessions board, which has none. */
  id: string;
  title: string;
}

/** The address of a board page on the local server. */
export function boardPageUrl(port: number, canvasKey: string, kind: string, id: string): string {
  return `http://127.0.0.1:${port}/${canvasKey}/board/${encodeURIComponent(kind)}/${id ? `?s=${encodeURIComponent(id)}` : ''}`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

/**
 * The tab's document: only the frame may load, and only from this computer's server on its
 * current port. The small script stores which session the tab shows, so VS Code can hand it back
 * after a restart.
 */
export function boardPanelHtml(options: { url: string; port: number; nonce: string; state: BoardPanelState }): string {
  const { url, port, nonce, state } = options;
  const policy = `default-src 'none'; frame-src http://127.0.0.1:${port}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<title>${escapeHtml(state.title)}</title>
<style nonce="${nonce}">html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; } iframe { border: 0; width: 100%; height: 100vh; display: block; }</style>
</head>
<body>
<iframe src="${escapeHtml(url)}" title="${escapeHtml(state.title)}"></iframe>
<script nonce="${nonce}">acquireVsCodeApi().setState(${JSON.stringify(state).replace(/</g, '\\u003c')});</script>
</body>
</html>`;
}

/** Shown in a board's tab while the local server is not running. */
export function boardUnavailableHtml(options: { nonce: string; state: BoardPanelState; reason: string }): string {
  const { nonce, state, reason } = options;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<title>${escapeHtml(state.title)}</title>
<style nonce="${nonce}">body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px 20px; }</style>
</head>
<body>
<h1>${escapeHtml(state.title)}</h1>
<p>${escapeHtml(reason)}</p>
<script nonce="${nonce}">acquireVsCodeApi().setState(${JSON.stringify(state).replace(/</g, '\\u003c')});</script>
</body>
</html>`;
}

/** What VS Code hands back for a restored tab, accepted only in its known shape. */
export function asBoardPanelState(value: unknown): BoardPanelState | undefined {
  const v = value as Partial<BoardPanelState> | null;
  if (typeof v !== 'object' || v === null) return undefined;
  if (typeof v.kind !== 'string' || !/^[a-z][a-z-]{0,40}$/.test(v.kind)) return undefined;
  if (typeof v.id !== 'string' || !/^[0-9a-f]{0,64}$/.test(v.id)) return undefined;
  if (typeof v.title !== 'string') return undefined;
  return { kind: v.kind, id: v.id, title: v.title.slice(0, 200) };
}
