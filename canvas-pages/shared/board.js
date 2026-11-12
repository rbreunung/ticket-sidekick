// The client every board page shares. A page holds no state of its own: it asks the extension for
// its session, shows what it gets, and sends actions back. Everything from Jira, Bitbucket or a
// report is written with textContent, never as HTML.

const params = new URLSearchParams(location.search);
const sessionId = params.get('s') ?? '';
const WAIT_MS = 20000;

/** Creates an element; `props` sets properties, `on*` adds listeners, `class` and `data-*`/`aria-*` set attributes. */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class' || key === 'role' || key.includes('-')) el.setAttribute(key, value === true ? '' : String(value));
    else el[key] = value;
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function formatTime(ms) {
  return ms ? new Date(ms).toLocaleString() : '';
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A request to this page's own routes; throws an Error carrying the server's short message. */
export async function api(method, name, body) {
  const response = await fetch(name, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    data = undefined;
  }
  if (!response.ok) {
    const error = new Error(data?.error ?? `The extension answered ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function applyTheme() {
  try {
    const { kind } = await api('GET', '../theme');
    document.documentElement.dataset.theme = kind;
  } catch {
    // The style falls back to the system's light or dark preference.
  }
}

/**
 * Runs a board page. `render(view, board)` returns the board's own content for the current view;
 * `board` offers `act`, `preview`, `save` and the current `state`.
 */
export function startBoard({ root, render }) {
  let state;
  let message;
  let busy = false;
  let stopped = false;

  const board = {
    get state() { return state; },
    /** A non-writing action. */
    async act(action) {
      await run(async () => { state = await api('POST', 'action', { s: sessionId, revision: state.revision, action }); });
    },
    async refresh() {
      await run(async () => { state = await api('POST', 'refresh', { s: sessionId }); });
    },
    /** Shows exactly what a writing action will do; nothing is written before Apply. */
    async preview(action) {
      await run(async () => {
        const plan = await api('POST', 'preview', { s: sessionId, revision: state.revision, action });
        showPlan(plan);
      });
    },
    async save(format) {
      await run(async () => {
        const { outcome } = await api('POST', 'save', { s: sessionId, format });
        message = outcome === 'saved' ? 'Saved.' : 'Save cancelled; nothing was written.';
      });
    },
    async discard() {
      await run(async () => {
        await api('POST', 'discard', { s: sessionId });
        stopped = true;
        message = 'This session was discarded. Ask for the board again to start a new one.';
        state = undefined;
      });
    },
  };

  async function run(work) {
    if (busy) return;
    busy = true;
    message = undefined;
    paint();
    try {
      await work();
    } catch (err) {
      message = err.message;
      // 409: the board changed meanwhile, so show what it is now.
      if (err.status === 409 || err.status === 404) await load();
    }
    busy = false;
    paint();
  }

  function showPlan(plan) {
    const dialog = h('dialog', { class: 'plan', 'aria-labelledby': 'plan-title' },
      h('h2', { id: 'plan-title' }, plan.title),
      h('p', { class: 'muted' }, plan.risky
        ? 'Nothing has been written yet. Apply asks you to confirm in a VS Code dialog.'
        : 'Nothing has been written yet.'),
      h('table', {}, h('tbody', {}, plan.lines.map(line => h('tr', {}, h('th', { scope: 'row' }, line.target), h('td', {}, line.change))))),
      h('div', { class: 'bar' },
        h('vscode-button', {
          autofocus: true,
          onClick: () => {
            dialog.close();
            void run(async () => {
              const applied = await api('POST', 'apply', { s: sessionId, planId: plan.planId });
              state = applied.state;
              const done = applied.results.filter(r => r.outcome === 'done').length;
              const rest = applied.results.filter(r => r.outcome !== 'done');
              message = `${done} written.` + (rest.length ? ` ${rest.length} not written: ${rest.map(r => `${r.target} (${r.reason ?? r.outcome})`).join('; ')}` : '');
            });
          },
        }, 'Apply'),
        h('vscode-button', { secondary: true, onClick: () => dialog.close() }, 'Cancel')));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  function banners() {
    const items = [];
    if (message) items.push(h('p', { class: 'banner', role: 'status' }, message));
    if (!state) return items;
    if (state.notice) items.push(h('p', { class: 'banner' }, state.notice));
    if (state.error) items.push(h('p', { class: 'banner error', role: 'alert' }, state.status === 'failed' ? `Could not load: ${state.error}` : `The check failed: ${state.error} The data shown is from ${formatTime(state.asOf)}.`));
    if (!state.stored && state.status === 'ready') items.push(h('p', { class: 'banner' }, 'This session is too large to store and will not survive a restart.'));
    if (state.conflicts.length > 0) {
      items.push(h('section', { class: 'banner conflicts', 'aria-label': 'Conflicts' },
        h('p', {}, `${state.conflicts.length} choice(s) no longer match what was just read:`),
        h('ul', {}, state.conflicts.map(c => h('li', {},
          h('strong', {}, c.target), ` ${c.message}`,
          c.stored !== undefined || c.fresh !== undefined ? h('span', { class: 'muted' }, ` Stored: ${c.stored ?? 'none'}. Now: ${c.fresh ?? 'none'}.`) : null,
          ' ', h('vscode-button', { secondary: true, onClick: () => board.act({ type: 'conflict/drop', id: c.id }) }, 'Drop'))))));
    }
    return items;
  }

  function paint() {
    const focusId = document.activeElement?.id;
    const header = h('header', {},
      h('h1', {}, state?.title ?? document.title),
      state ? h('p', { class: 'muted', role: 'status' },
        state.status === 'building' ? 'Reading…'
          : state.status === 'checking' ? `As of ${formatTime(state.asOf)}. Checking for changes…`
            : state.asOf ? `As of ${formatTime(state.asOf)}${state.restored ? ' (restored session)' : ''}.` : '') : null,
      state && !stopped ? h('div', { class: 'bar' },
        h('vscode-button', { id: 'refresh', secondary: true, disabled: busy || state.status !== 'ready' && state.status !== 'failed', onClick: () => board.refresh() }, 'Refresh'),
        h('vscode-button', { id: 'discard', secondary: true, disabled: busy, onClick: () => board.discard() }, 'Discard session')) : null);
    const content = state?.view !== undefined && !stopped ? render(state.view, board, busy) : null;
    root.replaceChildren(header, ...banners(), content ?? '');
    if (focusId) document.getElementById(focusId)?.focus();
  }

  async function load(tick) {
    const query = `state?s=${encodeURIComponent(sessionId)}` + (tick === undefined ? '' : `&tick=${tick}&wait=${WAIT_MS}`);
    state = await api('GET', query);
  }

  async function watch() {
    while (!stopped) {
      try {
        const before = state?.tick;
        await load(before);
        if (state.tick !== before && !busy) paint();
      } catch (err) {
        if (err.status === 404) {
          stopped = true;
          state = undefined;
          message = err.message;
          paint();
          return;
        }
        // The window may be restarting; try again shortly.
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }

  void applyTheme();
  void (async () => {
    try {
      await load();
    } catch (err) {
      message = err.message;
      if (err.status === 404) stopped = true;
    }
    paint();
    if (!stopped) void watch();
  })();
  return board;
}
