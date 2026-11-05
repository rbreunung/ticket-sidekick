// The inline ticket view the show-ticket tool points at (an MCP App). It runs in the host's
// sandboxed iframe, speaks the MCP Apps postMessage protocol directly (initialize, then wait for
// the tool result) and renders the ticket's key, summary and status. It loads nothing from the
// network and inserts every value as text, never as HTML.

const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';

export function buildTicketViewHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 16 16%27%3E%3Crect width=%2716%27 height=%2716%27 rx=%273%27 fill=%27%230052cc%27/%3E%3C/svg%3E">
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 12px; color: CanvasText; background: Canvas; }
  .card { border: 1px solid GrayText; border-radius: 6px; padding: 10px 12px; }
  .key { font-weight: 600; }
  .status { display: inline-block; margin-top: 6px; padding: 1px 8px; border-radius: 10px; border: 1px solid GrayText; font-size: 12px; }
  .muted { color: GrayText; }
</style>
</head>
<body>
<div class="card" id="card"><span class="muted">Loading ticket…</span></div>
<script>
(function () {
  var nextId = 1;
  function send(message) { window.parent.postMessage(Object.assign({ jsonrpc: '2.0' }, message), '*'); }
  function render(result) {
    var card = document.getElementById('card');
    var data = result && result.structuredContent;
    card.textContent = '';
    if (!data || !data.key) {
      var text = (result && result.content || []).filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join('\\n');
      card.textContent = text || 'No ticket data.';
      return;
    }
    var key = document.createElement('div'); key.className = 'key'; key.textContent = data.key;
    var summary = document.createElement('div'); summary.textContent = data.summary || '';
    var status = document.createElement('span'); status.className = 'status'; status.textContent = data.status || 'unknown status';
    card.appendChild(key); card.appendChild(summary); card.appendChild(status);
  }
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || msg.jsonrpc !== '2.0') return;
    if (msg.id === 1 && msg.result) send({ method: 'ui/notifications/initialized', params: {} });
    if (msg.method === 'ui/notifications/tool-result') render(msg.params);
  });
  send({ id: nextId++, method: 'ui/initialize', params: {
    appInfo: { name: 'ticket-sidekick-ticket-view', version: '0.0.1' },
    appCapabilities: {},
    protocolVersion: '${MCP_APPS_PROTOCOL_VERSION}'
  } });
})();
</script>
</body>
</html>`;
}
