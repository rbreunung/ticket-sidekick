import { api, formatBytes, formatTime, h } from '../shared/board.js';

// The sessions board: what Ticket Sidekick has cached for this workspace. A stored session is a
// cache of work in progress; Jira, Bitbucket and the report files stay the truth, so deleting one
// loses only unapplied choices.

const root = document.getElementById('root');
let sessions = [];
let message;

async function run(work) {
  message = undefined;
  try {
    sessions = (await work()).sessions;
  } catch (err) {
    message = err.message;
  }
  paint();
}

function paint() {
  root.replaceChildren(
    h('header', {},
      h('h1', {}, 'Stored sessions'),
      h('p', { class: 'muted' }, 'Work in progress that Ticket Sidekick keeps for this workspace so a board survives a restart. Deleting one discards unapplied choices; nothing in Jira or Bitbucket changes.'),
      h('div', { class: 'bar' },
        h('vscode-button', { id: 'reload', secondary: true, onClick: () => run(() => api('GET', 'list')) }, 'Refresh'),
        h('vscode-button', { id: 'delete-all', secondary: true, disabled: sessions.length === 0, onClick: () => run(() => api('POST', 'delete-all', {})) }, 'Delete all'))),
    message ? h('p', { class: 'banner error', role: 'alert' }, message) : '',
    sessions.length === 0 ? h('p', {}, 'No stored sessions.') : h('table', {},
      h('thead', {}, h('tr', {}, ['Board', 'Source', 'Data read', 'Last used', 'Size', ''].map(t => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, sessions.map(s => h('tr', {},
        h('th', { scope: 'row' }, s.title),
        h('td', {}, s.source),
        h('td', {}, formatTime(s.readAt)),
        h('td', {}, formatTime(s.lastUsedAt)),
        h('td', {}, formatBytes(s.bytes)),
        h('td', {}, h('div', { class: 'bar' },
          h('a', { href: `../${encodeURIComponent(s.kind)}/?s=${encodeURIComponent(s.id)}` }, 'Reopen'),
          h('vscode-button', { secondary: true, 'aria-label': `Delete ${s.title}`, onClick: () => run(() => api('POST', 'delete', { id: s.id })) }, 'Delete'))))))));
}

void (async () => {
  try {
    document.documentElement.dataset.theme = (await api('GET', '../theme')).kind;
  } catch {
    // The style falls back to the system preference.
  }
  await run(() => api('GET', 'list'));
})();
