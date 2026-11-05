// The canvas board page. Self-contained (inline script and styles, no network loads besides its
// own API under the same key path), and every Jira value is inserted with textContent. A write is
// two clicks: "Preview" asks the server for the exact text it will post, "Apply" posts that plan.

export function buildBoardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ticket board</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 16 16%27%3E%3Crect width=%2716%27 height=%2716%27 rx=%273%27 fill=%27%230052cc%27/%3E%3C/svg%3E">
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; background: Canvas; color: CanvasText; }
  h1 { font-size: 16px; margin: 0 0 12px; }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
  @media (max-width: 640px) { .layout { grid-template-columns: 1fr; } }
  ul { list-style: none; margin: 0; padding: 0; }
  li button { width: 100%; text-align: left; padding: 8px; margin-bottom: 6px; border: 1px solid GrayText; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
  li button[aria-pressed="true"] { outline: 2px solid Highlight; }
  .key { font-weight: 600; margin-right: 6px; }
  .status { font-size: 12px; color: GrayText; }
  textarea { width: 100%; box-sizing: border-box; min-height: 90px; }
  pre { white-space: pre-wrap; border: 1px dashed GrayText; padding: 8px; border-radius: 6px; }
  .row { display: flex; gap: 8px; margin-top: 8px; }
  .msg { margin-top: 8px; }
  [hidden] { display: none; }
</style>
</head>
<body>
<h1 id="title">Ticket board</h1>
<div class="layout">
  <section aria-label="Tickets"><ul id="tickets"><li class="status">Loading…</li></ul></section>
  <section aria-label="Comment">
    <div id="selected" class="status">Select a ticket.</div>
    <textarea id="comment" aria-label="Comment text" placeholder="Comment"></textarea>
    <div class="row"><button id="preview" type="button">Preview</button></div>
    <div id="previewBox" hidden>
      <pre id="previewText"></pre>
      <div class="row"><button id="apply" type="button">Apply</button><button id="cancel" type="button">Cancel</button></div>
    </div>
    <div id="msg" class="msg" role="status"></div>
  </section>
</div>
<script>
(function () {
  var base = location.pathname.replace(/\\/?$/, '/');
  var selected = null;
  var planId = null;
  function el(id) { return document.getElementById(id); }
  function say(text) { el('msg').textContent = text; }
  function call(method, path, body) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(base + path, opts).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); });
  }
  function closePreview() { planId = null; el('previewBox').hidden = true; }
  function load() {
    call('GET', 'api/tickets').then(function (r) {
      var list = el('tickets');
      list.textContent = '';
      if (!r.ok) { var e = document.createElement('li'); e.className = 'status'; e.textContent = r.body.error || 'Could not load tickets.'; list.appendChild(e); return; }
      el('title').textContent = 'Unresolved tickets in ' + r.body.project;
      r.body.tickets.forEach(function (t) {
        var li = document.createElement('li');
        var b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('aria-pressed', String(selected === t.key));
        var k = document.createElement('span'); k.className = 'key'; k.textContent = t.key;
        var s = document.createElement('span'); s.textContent = t.summary;
        var st = document.createElement('div'); st.className = 'status'; st.textContent = t.status;
        b.appendChild(k); b.appendChild(s); b.appendChild(st);
        b.addEventListener('click', function () { selected = t.key; el('selected').textContent = 'Comment on ' + t.key; closePreview(); load(); });
        li.appendChild(b);
        list.appendChild(li);
      });
    });
  }
  el('preview').addEventListener('click', function () {
    say('');
    call('POST', 'api/plan', { ticketKey: selected || '', comment: el('comment').value }).then(function (r) {
      if (!r.ok) { say(r.body.error || 'Could not prepare the comment.'); return; }
      planId = r.body.planId;
      el('previewText').textContent = r.body.preview;
      el('previewBox').hidden = false;
    });
  });
  el('cancel').addEventListener('click', function () { closePreview(); say('Nothing was written.'); });
  el('apply').addEventListener('click', function () {
    if (!planId) return;
    var id = planId;
    closePreview();
    call('POST', 'api/apply', { planId: id }).then(function (r) {
      say(r.ok ? 'Done: ' + r.body.message : (r.body.error || 'Could not add the comment.'));
      if (r.ok) { el('comment').value = ''; load(); }
    });
  });
  load();
})();
</script>
</body>
</html>`;
}
