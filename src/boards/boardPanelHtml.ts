// The document in a board's editor tab. The extension writes it; the page script, the shared
// client and the style are files shipped with the extension and loaded through the webview's own
// resource addresses. Pure, so the markup and its content policy are tested without VS Code.

export interface BoardPanelState {
  kind: string;
  /** The session the tab shows; empty for the sessions board, which has none. */
  id: string;
  title: string;
}

/** The addresses, as the webview sees them, of the files a board page loads. */
export interface BoardPageAssets {
  style: string;
  /** The VS Code Elements bundle (buttons and the like). */
  elements: string;
  /** The board's own page script. */
  page: string;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

/**
 * The tab's document. Scripts, styles and fonts load only from the extension's own files
 * (`cspSource`); nothing loads from the network and no inline script runs. The page reads which
 * board and session it shows from the root element and stores that with VS Code, which hands it
 * back when it restores the tab after a restart.
 */
export function boardPanelHtml(options: { cspSource: string; assets: BoardPageAssets; state: BoardPanelState }): string {
  const { cspSource, assets, state } = options;
  const policy = `default-src 'none'; script-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; img-src ${cspSource} data:`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(policy)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(state.title)}</title>
<link rel="stylesheet" href="${escapeHtml(assets.style)}">
<script type="module" src="${escapeHtml(assets.elements)}"></script>
<script type="module" src="${escapeHtml(assets.page)}"></script>
</head>
<body>
<main id="root" data-kind="${escapeHtml(state.kind)}" data-session="${escapeHtml(state.id)}" data-title="${escapeHtml(state.title)}"></main>
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
