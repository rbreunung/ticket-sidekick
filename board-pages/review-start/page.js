import { api, h } from '../shared/board.js';

// The pull request review start screen: the developer pastes the link of a Bitbucket pull request and
// opens its review board, which stops on its first step. The page holds no state of its own beyond
// the link being typed and names no session.

const root = document.getElementById('root');
let view;
let message;
let busy = false;
let typedUrl;

async function run(op, body) {
  if (busy) return;
  busy = true;
  message = undefined;
  paint();
  try {
    view = await api(op, body);
    if (op === 'open' && !view.problem) typedUrl = undefined;
  } catch (err) {
    message = err.message;
  }
  busy = false;
  paint();
}

function open() {
  const url = (typedUrl ?? view?.url ?? '').trim();
  if (url) void run('open', { url });
}

function paint() {
  const focusId = document.activeElement?.id;
  const content = view ? [
    view.bitbucketHint ? h('p', { class: 'banner error', role: 'alert' }, view.bitbucketHint) : null,
    h('div', { class: 'bar' },
      h('label', {}, 'Pull request link', h('input', {
        id: 'pr-url', type: 'text', size: 80, value: typedUrl ?? view.url, disabled: busy, autocomplete: 'off',
        placeholder: 'The pull request link, as shown in the browser',
        onInput: e => { typedUrl = e.target.value; },
        onKeydown: e => { if (e.key === 'Enter') open(); },
      })),
      h('vscode-button', { id: 'open', disabled: busy || Boolean(view.bitbucketHint), onClick: open }, 'Open')),
    view.problem ? h('p', { id: 'problem', class: 'banner error', role: 'alert' }, view.problem) : null,
    view.opened ? h('p', { class: 'muted', role: 'status' }, `Opened in its own tab: ${view.opened}.`) : null,
  ] : [h('p', { class: 'muted' }, 'Reading the settings…')];
  root.replaceChildren(
    h('header', {},
      h('h1', {}, 'Review a pull request'),
      h('p', { class: 'muted' }, 'Paste the link of a Bitbucket pull request. Its review board opens on the first step, where you pick the model and the requirements source; nothing runs before Start.')),
    message ? h('p', { class: 'banner error', role: 'alert' }, message) : '',
    ...content.filter(Boolean));
  if (focusId) document.getElementById(focusId)?.focus();
}

// A token set in another window shows when this tab is looked at again.
window.addEventListener('focus', () => { if (!busy) void run('view'); });
void run('view');
