// The client every board page shares. A page holds no state of its own: it asks the extension for
// its session, shows what it gets, and sends actions back. It runs in an editor tab (a webview) and
// talks to the extension over VS Code's message channel. Everything from Jira, Bitbucket or a
// report is written with textContent, never as HTML.

const vscode = acquireVsCodeApi();
const rootElement = document.getElementById('root');
const WAIT_MS = 20000;

// VS Code hands this back when it restores the tab after a restart.
vscode.setState({ kind: rootElement.dataset.kind, id: rootElement.dataset.session ?? '', title: rootElement.dataset.title ?? '' });

let nextRequest = 1;
const pending = new Map();
window.addEventListener('message', event => {
  const reply = event.data;
  const waiting = pending.get(reply?.id);
  if (!waiting) return;
  pending.delete(reply.id);
  if (reply.ok) {
    waiting.resolve(reply.data);
  } else {
    const error = new Error(reply.error ?? 'The extension could not answer.');
    error.status = reply.status;
    waiting.reject(error);
  }
});

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

/**
 * Says `text` through one polite live region that stays outside the board's content, so a screen
 * reader hears progress, refusals and marks even though the content is drawn again on each change.
 * The same text is also shown on the page; the region only reads it out, once per change.
 */
export function announce(text) {
  let region = document.getElementById('board-live');
  if (!region) {
    region = h('div', { id: 'board-live', class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });
    document.body.append(region);
  }
  const next = text ?? '';
  if (region.textContent !== next) region.textContent = next;
}

/**
 * A row of tabs after the WAI-ARIA tabs pattern: one tab in the Tab order, the arrow keys, Home and
 * End move to the next tab and select it. `tabs` are `{ id, label }`; `onSelect(id)` is called for
 * a click or a key, after focus moved to that tab. Tabs are never disabled, so switching them stays
 * possible while an Apply runs.
 */
export function tablist({ label, tabs, selected, onSelect }) {
  const select = (id) => {
    document.getElementById(`tab-${id}`)?.focus();
    onSelect(id);
  };
  const onKeydown = (event) => {
    const at = tabs.findIndex(t => t.id === selected);
    const moves = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    select(tabs[(moves[event.key] + tabs.length) % tabs.length].id);
  };
  return h('div', { class: 'tablist', role: 'tablist', 'aria-label': label },
    tabs.map(t => h('button', {
      id: `tab-${t.id}`, class: 'tab', role: 'tab', type: 'button',
      'aria-selected': t.id === selected ? 'true' : 'false', 'aria-controls': `panel-${t.id}`,
      tabIndex: t.id === selected ? 0 : -1,
      onClick: () => select(t.id), onKeydown,
    }, t.label)));
}

/** The panel of the selected tab of `tablist`. */
export function tabpanel(id, ...children) {
  return h('section', { id: `panel-${id}`, role: 'tabpanel', 'aria-labelledby': `tab-${id}`, tabIndex: 0 }, ...children);
}

export function formatTime(ms) {
  return ms ? new Date(ms).toLocaleString() : '';
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Where the developer was in the elements with ids under `root`: how far each scrolled box was
 * scrolled, and the caret or text selection in the field with the focus. A repaint replaces every
 * element, so without this a live list would jump to the top on each progress tick.
 */
function keptPlaces(root, active) {
  const places = [];
  const visit = el => {
    for (const child of el.children ?? []) {
      if (child.id) {
        const top = child.scrollTop ?? 0;
        const left = child.scrollLeft ?? 0;
        const caret = child === active && typeof child.selectionStart === 'number'
          ? { start: child.selectionStart, end: child.selectionEnd, direction: child.selectionDirection } : undefined;
        if (top > 0 || left > 0 || caret) places.push({ id: child.id, top, left, caret });
      }
      visit(child);
    }
  };
  visit(root);
  return places;
}

function restorePlaces(places) {
  for (const place of places) {
    const el = document.getElementById(place.id);
    if (!el) continue;
    if (place.top > 0) el.scrollTop = place.top;
    if (place.left > 0) el.scrollLeft = place.left;
    if (place.caret && el === document.activeElement) {
      try {
        if (typeof el.setSelectionRange === 'function') el.setSelectionRange(place.caret.start, place.caret.end, place.caret.direction ?? 'none');
        else { el.selectionStart = place.caret.start; el.selectionEnd = place.caret.end; }
      } catch {
        // A field whose type has no selection keeps the browser's own.
      }
    }
  }
}

/** A request to the extension about this tab's board; throws an Error carrying the extension's short message. */
export function api(op, body) {
  return new Promise((resolve, reject) => {
    const id = nextRequest++;
    pending.set(id, { resolve, reject });
    vscode.postMessage({ id, op, body: body ?? {} });
  });
}

/**
 * Runs a board page. `render(view, board, locked, state)` returns the board's own content for the
 * current view; `locked` is true while a request runs, an Apply is in progress or a model pass runs,
 * and the page disables its controls then. During a single model call only that call's control is
 * busy: the page asks `board.running(what)` and disables that one. `board` offers `act`, `preview`,
 * `run`, `stop`, `save` and the current `state`. `loading(state)`, when given, is shown while the
 * session has no view yet.
 */
export function startBoard({ root, render, loading }) {
  let state;
  let message;
  let busy = false;
  let stopped = false;
  let stopping = false;
  // The plan an Apply is running and the last Apply's results, for pages that show them per row.
  let applyingPlan;
  let lastApply;
  let applies = 0;

  const board = {
    get state() { return state; },
    /** The last refusal, failure or result line, as shown in the banner; undefined when there is none. */
    get message() { return message; },
    /** The plan whose Apply is running on this page. */
    get applyingPlan() { return applyingPlan; },
    /** `{ seq, title, lines, results, message }` of the last Apply on this page: its plan's lines, what each target gave, and its banner line. */
    get lastApply() { return lastApply; },
    /** Draws the page again from the current state, e.g. after a form field that is not sent yet changed the form's shape. */
    repaint() { paint(); },
    /**
     * A non-writing action; true when the session took it. With `quiet`, as for saving a typed field
     * when the developer leaves it, the page is not locked or drawn while it goes: the press that
     * moved the focus away must land on the button it was meant for. A refusal still shows.
     */
    async act(action, options) {
      if (options?.quiet) return quietly(async () => { state = await api('action', { revision: state.revision, action }); });
      return run(async () => { state = await api('action', { revision: state.revision, action }); });
    },
    /** Starts a model run the board kind names from `request`; its progress arrives with the state. */
    async run(request) {
      return run(async () => { state = await api('run', { revision: state.revision, request }); });
    },
    /** Stops a run: the pass without `what`. Sent while the board is locked, since the pass locks it. */
    async stop(what) {
      if (stopping) return;
      stopping = true;
      message = undefined;
      paint();
      try {
        state = await api('stop', what === undefined ? {} : { what });
      } catch (err) {
        message = err.message;
      }
      stopping = false;
      paint();
    },
    /** The run of this name while it goes on, `{ size, what, label, done, total }`; undefined otherwise. */
    running(what) {
      return state?.running?.find(r => r.what === what);
    },
    async refresh() {
      await run(async () => { state = await api('refresh'); });
    },
    /** One setting the board keeps for itself, outside its session (`state.preferences`); the extension refuses a name or value the board does not take. */
    async setPreference(name, value) {
      await run(async () => { state = await api('preference', { name, value }); });
    },
    /**
     * Writes what a writing action does in one click, with no dialog: the board on show is the
     * preview. The extension still plans first and refuses an action it cannot plan (nothing selected,
     * no change chosen), and that refusal shows as the banner.
     */
    async apply(action) {
      await run(async () => {
        const plan = await api('preview', { revision: state.revision, action });
        await applyPlan(plan);
      });
    },
    /** Shows exactly what a writing action will do; nothing is written before Apply. */
    async preview(action) {
      await run(async () => {
        const plan = await api('preview', { revision: state.revision, action });
        showPlan(plan);
      });
    },
    async save(format) {
      await run(async () => {
        const { outcome } = await api('save', { format });
        message = outcome === 'saved' ? 'Saved.' : 'Save cancelled; nothing was written.';
      });
    },
    /** "Pick the file again" for a board whose source file is missing; the file comes from VS Code's open dialog. */
    async pickFile() {
      await run(async () => {
        const picked = await api('pick-file');
        if (picked.outcome === 'picked') state = picked.state;
        else message = 'No file was picked; nothing changed.';
      });
    },
    async discard() {
      await run(async () => {
        await api('discard');
        stopped = true;
        message = 'This board was closed and its session discarded. Ask for the board again to start a new one.';
        state = undefined;
      });
    },
  };

  /** The model pass going on, which holds the whole board. */
  function passRun() {
    return state?.running?.find(r => r.size === 'pass');
  }

  /** An Apply or a model pass in progress, on this page or another: nothing else is sent until it ends. */
  function locked() {
    return busy || Boolean(state?.applying) || Boolean(passRun());
  }

  /** Runs `work` with the board locked; true when it went through, false when it was refused or not started. */
  async function run(work) {
    if (locked()) return false;
    busy = true;
    message = undefined;
    paint();
    const done = await attempt(work);
    busy = false;
    paint();
    return done;
  }

  /** Runs `work` without locking the board or drawing it first; nothing goes while an Apply or a pass holds the board. */
  async function quietly(work) {
    if (state?.applying || passRun()) return false;
    const done = await attempt(work);
    if (done && !busy) message = undefined;
    if (!busy) paint();
    return done;
  }

  async function attempt(work) {
    try {
      await work();
      return true;
    } catch (err) {
      message = err.message;
      // 409: the board changed meanwhile, so show what it is now.
      if (err.status === 409 || err.status === 404) await load().catch(() => undefined);
      return false;
    }
  }

  /** Writes a previewed plan once and keeps what it did: the message, and the plan's lines with each target's result. */
  async function applyPlan(plan) {
    applyingPlan = plan;
    try {
      const applied = await api('apply', { planId: plan.planId });
      state = applied.state;
      const done = applied.results.filter(r => r.outcome === 'done').length;
      const rest = applied.results.filter(r => r.outcome !== 'done');
      message = `${done} written.` + (rest.length ? ` ${rest.length} not written: ${rest.map(r => `${r.target} (${r.reason ?? r.outcome})`).join('; ')}` : '');
      lastApply = { seq: ++applies, title: plan.title, lines: plan.lines, results: applied.results, message };
    } finally {
      applyingPlan = undefined;
    }
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
            void run(() => applyPlan(plan));
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
    if (state.error) items.push(h('p', { class: 'banner error', role: 'alert' }, state.status === 'failed' ? `Could not load: ${state.error}` : `The check failed: ${state.error} The data shown is from ${formatTime(state.asOf)}.${state.writesBlocked ? ' Nothing can be applied until a check passes: use Refresh.' : ''}`));
    if (!state.stored && state.status === 'ready') items.push(h('p', { class: 'banner' }, 'This session is too large to store and will not survive a restart.'));
    return items;
  }

  // While a mouse button is held the page is not drawn again: a click needs its press and release on
  // the same element, and drawing replaces every element. The drawing waits for the release (and
  // the click it gives), or a second at most, in case the release happened outside the tab.
  let pointerHeld = false;
  let paintWaiting;
  document.addEventListener('pointerdown', () => { pointerHeld = true; }, true);
  const released = () => {
    if (!pointerHeld) return;
    pointerHeld = false;
    if (paintWaiting) setTimeout(paintNow, 0);
  };
  document.addEventListener('pointerup', released, true);
  document.addEventListener('pointercancel', released, true);
  window.addEventListener('blur', released);

  // Text the developer selected on the board (to copy it) would go with the elements it is in, so
  // drawing waits while a selection is open too, until it closes or five seconds at most.
  const selectingText = () => {
    // A selection inside a text box is the box's own, and the redraw keeps its caret.
    if (/^(INPUT|TEXTAREA|VSCODE-TEXTAREA|VSCODE-TEXTFIELD)$/.test(document.activeElement?.tagName ?? '')) return false;
    const selection = document.getSelection?.();
    return !!selection && !selection.isCollapsed && selection.rangeCount > 0 && root.contains(selection.anchorNode);
  };
  document.addEventListener('selectionchange', () => {
    if (paintWaiting && !pointerHeld && !selectingText()) setTimeout(paintNow, 0);
  });

  function paint() {
    const selecting = selectingText();
    if (!pointerHeld && !selecting) {
      paintNow();
      return;
    }
    if (paintWaiting) return;
    paintWaiting = setTimeout(() => { pointerHeld = false; paintNow(); }, selecting ? 5000 : 1000);
  }

  function paintNow() {
    if (paintWaiting) clearTimeout(paintWaiting);
    paintWaiting = undefined;
    const focusId = document.activeElement?.id;
    const kept = keptPlaces(root, document.activeElement);
    const applying = state?.applying;
    // A board whose view says it shows its own run line and Stop gets neither in the header.
    const pass = state?.view?.ownRunLine ? undefined : passRun();
    const header = h('header', {},
      h('h1', {}, state?.title ?? rootElement.dataset.title ?? ''),
      state ? h('p', { class: 'muted', role: 'status' },
        applying ? `Applying: ${applying.done} of ${applying.total} done…`
          : pass ? `Running ${pass.label}: ${pass.done} of ${pass.total} done…`
          : state.status === 'building' ? 'Reading…'
            : state.status === 'checking' ? `As of ${formatTime(state.asOf)}. Checking for changes…`
              : state.asOf ? `As of ${formatTime(state.asOf)}${state.restored ? ' (restored session)' : ''}.` : '') : null,
      applying ? h('progress', { id: 'apply-progress', max: applying.total, value: applying.done, 'aria-label': 'Apply progress' }) : null,
      pass ? h('progress', { id: 'run-progress', max: pass.total, value: pass.done, 'aria-label': 'Run progress' }) : null,
      // A page that draws its own action line (`view.ownActionLine`) has no Refresh or Close here.
      state && !stopped && !state.view?.ownActionLine ? h('div', { class: 'bar' },
        pass ? h('vscode-button', { id: 'stop-run', disabled: stopping, onClick: () => board.stop() }, 'Stop') : null,
        h('vscode-button', { id: 'refresh', secondary: true, disabled: locked() || state.status !== 'ready' && state.status !== 'failed', onClick: () => board.refresh() }, 'Refresh'),
        h('vscode-button', {
          id: 'discard', secondary: true, disabled: locked(), title: 'Closes this tab and forgets the choices not applied yet. Nothing in Jira changes.',
          onClick: () => board.discard(),
        }, 'Close')) : null);
    const content = state?.view !== undefined && !stopped ? render(state.view, board, locked(), state)
      : state && !stopped && loading ? loading(state) : null;
    root.replaceChildren(header, ...banners(), content ?? '');
    if (focusId) document.getElementById(focusId)?.focus();
    restorePlaces(kept);
  }

  async function load(tick) {
    state = await api('state', tick === undefined ? {} : { tick, wait: WAIT_MS });
  }

  async function watch() {
    while (!stopped) {
      try {
        const before = state?.tick;
        await load(before);
        // Painted while a request runs too, so an Apply shows its progress as each target finishes.
        if (state.tick !== before) paint();
      } catch (err) {
        if (err.status === 404) {
          stopped = true;
          state = undefined;
          message = err.message;
          paint();
          return;
        }
        // The extension may be restarting; try again shortly.
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }

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
