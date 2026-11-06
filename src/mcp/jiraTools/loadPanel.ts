import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { LoadTicketCoreResult, SkippedAttachment } from '../../participant/jira/loadCore';
import { formatFileSize } from '../../utils/attachmentEligibility';
import { defineTool, type McpViewResource } from '../mcpServer';
import type { JiraToolDeps } from './jiraAccess';

// The inline panel (an MCP App) shown under a load ticket result. Load ticket hands it the
// skipped attachments as structured data next to its text answer; the panel lets the user fetch
// the ones a second request can still get.
//
// This is a probe build of the panel: it checks, in a real chat, that a panel with nothing to
// show leaves no frame, that the panel receives the structured data, that it can call a tool
// only it can see, and that its context note reaches the agent.

export const LOAD_PANEL_URI = 'ui://ticket-sidekick/load-panel.html';

/** Skipped attachments that a second request can still fetch. */
export const FETCHABLE_CAUSES: ReadonlySet<SkippedAttachment['cause']> = new Set(['not-default-type', 'download-failed']);

export interface PanelAttachment {
  filename: string;
  size: string;
  reason: string;
  fetchable: boolean;
}

export interface LoadPanelData extends Record<string, unknown> {
  /** Identifies this load result, so a panel drawn again from it can find its saved state. */
  loadId: string;
  ticketKey: string;
  skipped: PanelAttachment[];
}

/** The structured data load ticket hands its panel: each skipped attachment and whether it can be fetched. */
export function loadPanelData(ticketKey: string, result: LoadTicketCoreResult, newId: () => string = randomUUID): LoadPanelData {
  return {
    loadId: newId(),
    ticketKey,
    skipped: result.skipped.map(s => ({
      filename: s.filename,
      size: formatFileSize(s.size),
      reason: s.reason,
      fetchable: FETCHABLE_CAUSES.has(s.cause),
    })),
  };
}

export const PANEL_PROBE_TOOL = 'jira_load_panel_probe';

const PROBE_WORDS = ['amber', 'birch', 'cobalt', 'dune', 'ember', 'fjord', 'garnet', 'harbor'];

export const panelProbeTool = defineTool<JiraToolDeps, { ticketKey: z.ZodString }>({
  name: PANEL_PROBE_TOOL,
  title: 'Load panel probe',
  description: 'Answers the load panel with a probe word. Called only by the panel.',
  inputSchema: { ticketKey: z.string().describe('The ticket key the panel shows.') },
  annotations: { readOnlyHint: true },
  visibility: ['app'],
  handler: async ({ ticketKey }) => {
    const word = PROBE_WORDS[Math.floor(Math.random() * PROBE_WORDS.length)];
    return { text: `Probe for ${ticketKey}: ${word}`, structuredContent: { word } };
  },
});

const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';

function buildLoadPanelHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: var(--font-sans, system-ui, sans-serif); font-size: 13px; margin: 0; padding: 8px 10px; color: var(--color-text-primary, CanvasText); background: transparent; }
  #panel[hidden] { display: none; }
  .row { margin: 4px 0; }
  button { font: inherit; padding: 2px 10px; cursor: pointer; }
  .muted { opacity: 0.75; }
</style>
</head>
<body>
<div id="panel" hidden></div>
<script>
(function () {
  var nextId = 1;
  var pending = {};
  var panel = document.getElementById('panel');
  function send(message) { window.parent.postMessage(Object.assign({ jsonrpc: '2.0' }, message), '*'); }
  function request(method, params) {
    var id = nextId++;
    send({ id: id, method: method, params: params });
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }
  function reportHeight(height) { send({ method: 'ui/notifications/size-changed', params: { height: height } }); }
  function line(text, className) {
    var div = document.createElement('div');
    div.className = 'row' + (className ? ' ' + className : '');
    div.textContent = text;
    panel.appendChild(div);
    return div;
  }
  function render(result) {
    var data = result && !result.isError && result.structuredContent;
    var skipped = data && Array.isArray(data.skipped) ? data.skipped : [];
    var fetchable = skipped.filter(function (s) { return s && s.fetchable; });
    panel.textContent = '';
    if (fetchable.length === 0) { panel.hidden = true; reportHeight(0); return; }
    panel.hidden = false;
    line('Load panel probe for ' + String(data.ticketKey) + ': ' + fetchable.length + ' attachment(s) could be fetched.');
    skipped.forEach(function (s) { line(String(s.filename) + ' (' + String(s.size) + '): ' + String(s.reason), 'muted'); });
    var status = line('Load ID ' + String(data.loadId), 'muted');
    var button = document.createElement('button');
    button.textContent = 'Run probe';
    button.addEventListener('click', function () {
      button.disabled = true;
      status.textContent = 'Calling the probe tool...';
      request('tools/call', { name: '${PANEL_PROBE_TOOL}', arguments: { ticketKey: String(data.ticketKey) } }).then(function (res) {
        var word = res && res.structuredContent && res.structuredContent.word;
        if (!word) throw new Error('the probe answered without a word');
        var note = 'Ticket Sidekick load panel probe for ' + String(data.ticketKey) + ': the probe word is ' + String(word) + '.';
        return request('ui/update-model-context', { content: [{ type: 'text', text: note }] }).then(function () {
          status.textContent = 'Probe tool answered and the context note was sent. Ask the agent: what is the load panel probe word?';
          reportHeight(document.documentElement.scrollHeight);
        });
      }).catch(function (err) {
        status.textContent = 'Probe failed: ' + String(err && err.message || err);
        button.disabled = false;
        reportHeight(document.documentElement.scrollHeight);
      });
    });
    panel.appendChild(button);
    reportHeight(document.documentElement.scrollHeight);
  }
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || msg.jsonrpc !== '2.0') return;
    if (msg.id !== undefined && pending[msg.id] && (msg.result !== undefined || msg.error)) {
      var entry = pending[msg.id];
      delete pending[msg.id];
      if (msg.error) entry.reject(new Error(msg.error.message || 'request failed')); else entry.resolve(msg.result);
      return;
    }
    if (msg.method === 'ui/notifications/tool-result') render(msg.params);
  });
  // VS Code draws a view 300 px tall until it reports a height, so report 0 before anything else.
  reportHeight(0);
  request('ui/initialize', {
    appInfo: { name: 'ticket-sidekick-load-panel', version: '0.0.1' },
    appCapabilities: {},
    protocolVersion: '${MCP_APPS_PROTOCOL_VERSION}'
  }).then(function () { send({ method: 'ui/notifications/initialized', params: {} }); });
})();
</script>
</body>
</html>`;
}

export const loadPanelView: McpViewResource = {
  name: 'load-panel',
  uri: LOAD_PANEL_URI,
  title: 'Skipped attachments',
  html: buildLoadPanelHtml,
};
