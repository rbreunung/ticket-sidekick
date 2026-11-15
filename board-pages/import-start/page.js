import { api, h } from '../shared/board.js';

// The import start screen: the report kind and file, and the template, issue type and project the
// import takes from the settings, for checking before Open. The page holds no state of its own and
// names no file path, setting or session: the extension opens the file dialog, saves a picked
// template or project to its setting and opens the import board.

const root = document.getElementById('root');
let view;
let message;
let busy = false;
let typedIssueType = '';

async function run(op, body) {
  if (busy) return;
  busy = true;
  message = undefined;
  paint();
  try {
    view = await api(op, body);
  } catch (err) {
    message = err.message;
  }
  busy = false;
  paint();
}

function row(label, ...value) {
  return h('tr', {}, h('th', { scope: 'row' }, label), h('td', {}, ...value));
}

function kindPicker() {
  return h('label', {}, 'Report kind',
    h('select', { id: 'kind', disabled: busy, onChange: e => run('kind', { kind: e.target.value }) },
      view.kinds.map(k => h('option', { value: k.id, selected: k.id === view.kind }, k.label))));
}

function reportCell() {
  const { report } = view;
  return [
    report.fileName ? h('span', { title: report.path }, report.fileName) : h('span', { class: 'muted' }, 'No file chosen.'),
    report.items !== undefined ? h('span', { class: 'muted' }, ` ${report.items} item(s) to review.`) : null,
    ' ', h('vscode-button', { id: 'pick-file', secondary: true, disabled: busy, onClick: () => run('pick-file') }, report.fileName ? 'Choose another file…' : 'Choose file…'),
  ];
}

function templateCell() {
  const { template } = view;
  if (template.problem) return h('span', {}, template.problem);
  if (template.name) return [h('span', {}, template.name), h('span', { class: 'muted' }, ` (from ${template.settingKey})`)];
  return [
    h('p', {}, template.askReason),
    h('select', { id: 'template', 'aria-label': 'Template', disabled: busy, onChange: e => { if (e.target.value) void run('template', { name: e.target.value }); } },
      h('option', { value: '', selected: true }, 'Choose a template…'),
      template.options.map(name => h('option', { value: name }, name))),
  ];
}

function issueTypeCell() {
  const { issueType, template } = view;
  if (!template.name) return h('span', { class: 'muted' }, 'Comes from the template.');
  if (issueType.fromTemplate) return [h('span', {}, issueType.name), h('span', { class: 'muted' }, ' (from the template)')];
  if (issueType.options) {
    return h('select', { id: 'issue-type', 'aria-label': 'Issue type', disabled: busy, onChange: e => { if (e.target.value) void run('issue-type', { name: e.target.value }); } },
      h('option', { value: '', selected: !issueType.name }, 'Choose an issue type…'),
      issueType.options.map(name => h('option', { value: name, selected: name === issueType.name }, name)));
  }
  if (issueType.typed) {
    return [
      h('p', { class: 'banner' }, issueType.warning),
      h('input', { id: 'issue-type-typed', type: 'text', 'aria-label': 'Issue type', value: issueType.name ?? typedIssueType, size: 24, onInput: e => { typedIssueType = e.target.value; } }),
      ' ', h('vscode-button', { secondary: true, disabled: busy, onClick: () => run('issue-type', { name: typedIssueType || issueType.name || '' }) }, 'Use'),
    ];
  }
  return h('span', { class: 'muted' }, 'Read from the project once Jira and the project are set.');
}

function projectCell() {
  const { project } = view;
  if (project.options) {
    return [
      h('p', {}, project.askReason),
      h('select', { id: 'project', 'aria-label': 'Project', disabled: busy, onChange: e => { if (e.target.value) void run('project', { key: e.target.value }); } },
        h('option', { value: '', selected: true }, 'Choose a project…'),
        project.options.map(p => h('option', { value: p.key }, `${p.key} — ${p.name}`))),
    ];
  }
  if (!project.problem) return [h('span', {}, project.key ?? ''), project.key ? h('span', { class: 'muted' }, ' (from ticketSidekick.jira.defaultProject)') : null];
  return [
    h('p', { class: 'banner', role: 'alert' }, project.problem),
    h('vscode-button', { id: 'open-project-setting', secondary: true, disabled: busy, onClick: () => run('open-setting', { setting: 'project' }) }, 'Open Setting'),
  ];
}

function actions() {
  if (view.jiraHint) return h('p', { class: 'banner error', role: 'alert' }, view.jiraHint);
  return h('div', { class: 'bar' },
    h('vscode-button', { id: 'open', disabled: busy || !view.canOpen, onClick: () => run('open') }, view.stored ? 'Open stored import' : 'Open'),
    view.stored ? h('vscode-button', { id: 'start-over', secondary: true, disabled: busy || !view.canOpen, onClick: () => run('start-over') }, 'Start over') : null,
    view.blocker ? h('span', { class: 'muted', role: 'status' }, view.blocker) : null);
}

function paint() {
  const focusId = document.activeElement?.id;
  const content = view ? [
    h('div', { class: 'bar' }, kindPicker()),
    h('table', {}, h('tbody', {},
      row('Report file', reportCell()),
      view.report.problem ? row('', h('p', { class: 'banner error', role: 'alert' }, view.report.problem)) : null,
      row('Project', projectCell()),
      row('Template', templateCell()),
      row('Issue type', issueTypeCell()))),
    view.stored ? h('p', { class: 'banner' }, 'An import of this file in this project is stored. Open shows it as it is, with the template it was started with; Start over discards it and starts again with the template above.') : null,
    actions(),
  ] : [h('p', { class: 'muted' }, 'Reading the settings…')];
  root.replaceChildren(
    h('header', {},
      h('h1', {}, 'Open import'),
      h('p', { class: 'muted' }, 'Choose the report. The template, issue type and project come from the settings; check them before you open the import.')),
    message ? h('p', { class: 'banner error', role: 'alert' }, message) : '',
    ...content);
  if (focusId) document.getElementById(focusId)?.focus();
}

// A settings change made in another tab shows when this tab is looked at again.
window.addEventListener('focus', () => { if (!busy) void run('view'); });
void run('view');
