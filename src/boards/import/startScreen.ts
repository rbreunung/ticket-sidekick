import * as path from 'path';
import { normalizeProjectKey } from '../../services/configValidation';
import { defaultProjectWarning } from '../../services/defaultProjectCheck';
import { buildJiraNotConfiguredMessage } from '../../services/setupHints';
import { SessionError } from '../../sessions/sessionTypes';
import type { JiraTemplate } from '../../templates/TemplateService';
import type { JiraAccess } from '../../tools/jiraTools/jiraAccess';
import type { DiagLogger } from '../../utils/diagTypes';
import { JiraApiError } from '../../utils/apiError';
import type { ReportImportDescriptor } from '../../imports/descriptor';
import type { ReviewRowBase } from '../../imports/types';
import {
  REPORT_KINDS, REPORT_KIND_LABELS, importSessionId, isReportKind, normaliseReportPath,
  type ImportRecipe, type ReportKind,
} from './recipe';

// The start screen of an import: a tab without a session. The developer picks the report kind and
// the report file; the template comes from `ticketSidekick.<kind>.template`, the issue type from
// that template and the project from `ticketSidekick.jira.defaultProject`. The template is asked
// for only when its setting is empty or names a template that is gone, and the choice is saved to
// the setting. The default project is never written: a missing or wrong one shows the notice with
// Open Setting. Open hands the full recipe to the import board. vscode-free: the native file
// dialog, the setting writes and the board opening are supplied by the host.

export const IMPORT_START_BOARD = 'import-start';
export const IMPORT_START_TITLE = 'Open import';

const DEFAULT_PROJECT_SETTING = 'ticketSidekick.jira.defaultProject';
/** The settings the page may ask to open, by a name of its own; the page never names a setting key. */
const OPENABLE_SETTINGS: Record<string, string> = { project: DEFAULT_PROJECT_SETTING };
const MAX_ISSUE_TYPE_LENGTH = 255;

export function templateSettingKey(kind: ReportKind): string {
  return `ticketSidekick.${kind}.template`;
}

/** The warning the Veracode import shows when the project's issue types cannot be read; the start screen shows it for both kinds. */
export function issueTypeFetchWarning(projectKey: string, message: string): string {
  return `Ticket Sidekick: Could not fetch issue types for ${projectKey} — you'll be asked to type it. ${message}`;
}

/** How a report kind's file is chosen and read on the start screen. */
export interface ReportReader {
  /** Reads, size-checks, parses and filters the report; throws with the message to show. */
  read(filePath: string): Promise<{ items: unknown[]; rawItems: unknown[] }>;
  noMatchMessage: string;
  fileFilter: { label: string; extensions: string[] };
}

/** The reader of a Veracode or Waltz descriptor. */
export function reportReaderOf<TItem, TRow extends ReviewRowBase>(descriptor: ReportImportDescriptor<TItem, TRow>): ReportReader {
  const { parseAndFilter, fileFilter } = descriptor;
  if (!parseAndFilter || !fileFilter) throw new Error(`The ${descriptor.descriptorKind} import reads no report file.`);
  return { read: parseAndFilter, noMatchMessage: descriptor.noMatchMessage, fileFilter };
}

export interface ImportStartDeps {
  /** The current Jira settings, plus a client when Jira is configured. */
  jira(): Promise<JiraAccess>;
  defaultProject(): string;
  templateSetting(kind: ReportKind): string;
  /** Saves the picked template to `ticketSidekick.<kind>.template`. */
  writeTemplateSetting(kind: ReportKind, name: string): Promise<void>;
  /** The templates of `.jira-templates.json`; throws when the file cannot be read. */
  templates(): JiraTemplate[];
  reportReader(kind: ReportKind): ReportReader;
  /** VS Code's native open dialog; undefined when it was cancelled. */
  pickReportFile(kind: ReportKind, filter: ReportReader['fileFilter']): Promise<string | undefined>;
  /** Opens VS Code's Settings at this setting. */
  openSetting(key: string): Promise<void>;
  hasSession(id: string): Promise<boolean>;
  discardSession(id: string): Promise<void>;
  /** Opens the import board with the full recipe. */
  openImport(recipe: ImportRecipe): Promise<{ ok: true } | { ok: false; reason: string }>;
  onDiag?: DiagLogger;
}

export interface StartScreenView {
  kind: ReportKind;
  kinds: Array<{ id: ReportKind; label: string }>;
  report: { path?: string; fileName?: string; items?: number; problem?: string };
  /** The default project; `problem` is the notice the page shows with Open Setting. */
  project: { key?: string; problem?: string };
  template: {
    /** The setting as it is now. */
    setting: string;
    settingKey: string;
    /** The template the import uses; absent while one must be picked. */
    name?: string;
    /** The templates to pick from, present only when one must be picked. */
    options?: string[];
    askReason?: string;
    problem?: string;
  };
  issueType: {
    name?: string;
    fromTemplate: boolean;
    /** The project's issue types to pick from when the template names none. */
    options?: string[];
    /** True when the issue types could not be read and the issue type is typed instead. */
    typed?: boolean;
    warning?: string;
  };
  /** The Jira setup hint, shown instead of Open while Jira is not configured. */
  jiraHint?: string;
  /** An import of this file in this project is stored already: Open shows it as it is, Start over begins again. */
  stored: boolean;
  canOpen: boolean;
  /** What stops Open, when something does. */
  blocker?: string;
}

type ReportResult = { items: number } | { problem: string };

interface StartState {
  kind: ReportKind;
  reportPath?: string;
  /** The issue type picked for a template that names none, with that template's name. */
  issueType?: { template: string; name: string };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stringOf(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new SessionError(400, `Invalid ${what}.`);
  return value.trim();
}

export class ImportStartScreen {
  private state: StartState = { kind: REPORT_KINDS[0] };
  private reports = new Map<string, ReportResult>();
  /** Issue types of the projects read so far; only successful reads are kept. */
  private projects = new Map<string, string[]>();

  constructor(private readonly deps: ImportStartDeps) {}

  /** Starts on a kind and a report file the board was asked for with; anything else in the input is ignored. */
  prefill(input: unknown): void {
    const v = (typeof input === 'object' && input !== null ? input : {}) as { kind?: unknown; reportPath?: unknown };
    if (!isReportKind(v.kind)) return;
    if (v.kind !== this.state.kind) this.state = { kind: v.kind };
    if (typeof v.reportPath === 'string' && path.isAbsolute(v.reportPath)) this.setReport(v.reportPath);
  }

  /** Answers one request of the start screen's page. */
  async handle(op: string, body: Record<string, unknown>): Promise<StartScreenView> {
    switch (op) {
      case 'view':
        return this.view();
      case 'kind': {
        if (!isReportKind(body.kind)) throw new SessionError(400, 'Invalid report kind.');
        if (body.kind !== this.state.kind) this.state = { kind: body.kind };
        return this.view();
      }
      case 'pick-file': {
        const kind = this.state.kind;
        const picked = await this.deps.pickReportFile(kind, this.deps.reportReader(kind).fileFilter);
        // A cancelled dialog changes nothing; so does a kind changed while it was open.
        if (picked && kind === this.state.kind) this.setReport(picked);
        return this.view();
      }
      case 'template': {
        const name = stringOf(body.name, 'template');
        const names = this.loadTemplates().templates.map(t => t.name);
        if (!names.includes(name)) throw new SessionError(400, `There is no template "${name}" in .jira-templates.json.`);
        await this.deps.writeTemplateSetting(this.state.kind, name);
        this.deps.onDiag?.('info', 'Import template setting saved', { setting: templateSettingKey(this.state.kind) });
        return this.view();
      }
      case 'issue-type': {
        const name = stringOf(body.name, 'issue type');
        if (name.length > MAX_ISSUE_TYPE_LENGTH) throw new SessionError(400, 'Invalid issue type.');
        const view = await this.view();
        if (!view.template.name || view.issueType.fromTemplate) throw new SessionError(409, 'The issue type comes from the template.');
        if (view.issueType.options && !view.issueType.options.includes(name)) throw new SessionError(400, `The project has no issue type "${name}".`);
        if (!view.issueType.options && !view.issueType.typed) throw new SessionError(409, 'The project\'s issue types are not known yet.');
        this.state.issueType = { template: view.template.name, name };
        return this.view();
      }
      case 'open':
        return this.open(false);
      case 'start-over':
        return this.open(true);
      case 'open-setting': {
        const key = typeof body.setting === 'string' ? OPENABLE_SETTINGS[body.setting] : undefined;
        if (!key) throw new SessionError(400, 'Invalid setting.');
        await this.deps.openSetting(key);
        return this.view();
      }
      default:
        throw new SessionError(404, 'Unknown request.');
    }
  }

  private setReport(filePath: string): void {
    const reportPath = normaliseReportPath(filePath);
    this.state.reportPath = reportPath;
    // A file picked again is read again: it may have been replaced.
    this.reports.delete(`${this.state.kind}\n${reportPath}`);
  }

  private loadTemplates(): { templates: JiraTemplate[]; problem?: string } {
    try {
      return { templates: this.deps.templates() };
    } catch (err) {
      return { templates: [], problem: errorText(err) };
    }
  }

  private async readReport(kind: ReportKind, reportPath: string): Promise<ReportResult> {
    const key = `${kind}\n${reportPath}`;
    const known = this.reports.get(key);
    if (known) return known;
    const reader = this.deps.reportReader(kind);
    let result: ReportResult;
    try {
      const { items } = await reader.read(reportPath);
      result = items.length > 0 ? { items: items.length } : { problem: reader.noMatchMessage };
    } catch (err) {
      const message = errorText(err);
      this.deps.onDiag?.('warn', 'Could not read the report on the import start screen', { kind, error: message });
      result = { problem: `Could not import report: ${message}` };
    }
    this.reports.set(key, result);
    return result;
  }

  /** The project and its issue types: read from Jira when it is configured and the key is well formed. */
  private async readProject(access: JiraAccess): Promise<{ key?: string; problem?: string; issueTypes?: string[]; issueTypeError?: string }> {
    const value = this.deps.defaultProject().trim();
    if (!value) {
      return { problem: `No default project is set. Set ${DEFAULT_PROJECT_SETTING} to the Jira project the tickets go to.` };
    }
    const key = normalizeProjectKey(value);
    if (!key) return { problem: defaultProjectWarning({ kind: 'malformed', value }) };
    if (!access.configured) return { key };
    const known = this.projects.get(key);
    if (known) return { key, issueTypes: known };
    try {
      const project = await access.client.getProject(key);
      const issueTypes = project.issueTypes.filter(t => !t.subtask).map(t => t.name);
      this.projects.set(key, issueTypes);
      return { key, issueTypes };
    } catch (err) {
      if (err instanceof JiraApiError && err.isNotFound) return { key, problem: defaultProjectWarning({ kind: 'not-found', project: key }) };
      this.deps.onDiag?.('warn', `Could not fetch issue types — ${key}, you'll be asked to type it`, { projectKey: key, error: errorText(err) });
      return { key, issueTypeError: errorText(err) };
    }
  }

  async view(): Promise<StartScreenView> {
    const { kind, reportPath } = this.state;
    const access = await this.deps.jira();
    const jiraHint = access.configured ? undefined : buildJiraNotConfiguredMessage(access.config);
    const project = await this.readProject(access);

    const { templates, problem: templatesProblem } = this.loadTemplates();
    const setting = this.deps.templateSetting(kind).trim();
    const settingKey = templateSettingKey(kind);
    const chosen = templates.find(t => t.name === setting);
    const template: StartScreenView['template'] = { setting, settingKey };
    if (templatesProblem) {
      template.problem = templatesProblem;
    } else if (templates.length === 0) {
      template.problem = 'There are no templates in .jira-templates.json in this workspace. Add one to import a report.';
    } else if (chosen) {
      template.name = chosen.name;
    } else {
      template.options = templates.map(t => t.name);
      template.askReason = setting
        ? `The template "${setting}" in ${settingKey} is not in .jira-templates.json. Pick a template; it is saved to the setting.`
        : `${settingKey} is empty. Pick the template for ${REPORT_KIND_LABELS[kind]} imports; it is saved to the setting.`;
    }

    const issueType: StartScreenView['issueType'] = { fromTemplate: false };
    const ownIssueType = chosen?.issueType?.trim();
    if (ownIssueType) {
      issueType.name = ownIssueType;
      issueType.fromTemplate = true;
    } else if (chosen) {
      const picked = this.state.issueType?.template === chosen.name ? this.state.issueType.name : undefined;
      if (project.issueTypes) {
        issueType.options = project.issueTypes;
        if (picked && project.issueTypes.includes(picked)) issueType.name = picked;
      } else if (project.issueTypeError && project.key) {
        issueType.typed = true;
        issueType.warning = issueTypeFetchWarning(project.key, project.issueTypeError);
        if (picked) issueType.name = picked;
      }
    }

    const report: StartScreenView['report'] = {};
    if (reportPath) {
      report.path = reportPath;
      report.fileName = path.basename(reportPath);
      const read = await this.readReport(kind, reportPath);
      if ('items' in read) report.items = read.items;
      else report.problem = read.problem;
    }

    const stored = project.key && reportPath ? await this.deps.hasSession(importSessionId({ kind, projectKey: project.key, reportPath })) : false;

    const blocker = jiraHint
      ?? project.problem
      ?? template.problem
      ?? (!reportPath ? 'Choose the report file.' : undefined)
      ?? report.problem
      ?? (!template.name ? 'Pick a template.' : undefined)
      ?? (!issueType.name ? 'Pick an issue type.' : undefined);
    return {
      kind,
      kinds: REPORT_KINDS.map(id => ({ id, label: REPORT_KIND_LABELS[id] })),
      report, project: { ...(project.key ? { key: project.key } : {}), ...(project.problem ? { problem: project.problem } : {}) },
      template, issueType,
      ...(jiraHint ? { jiraHint } : {}),
      stored,
      canOpen: blocker === undefined,
      ...(blocker ? { blocker } : {}),
    };
  }

  private async open(startOver: boolean): Promise<StartScreenView> {
    const view = await this.view();
    if (!view.canOpen) throw new SessionError(409, view.blocker ?? 'The import cannot be opened yet.');
    const recipe: ImportRecipe = {
      kind: view.kind,
      projectKey: view.project.key as string,
      reportPath: view.report.path as string,
      templateName: view.template.name as string,
      issueType: view.issueType.name as string,
    };
    if (startOver) {
      await this.deps.discardSession(importSessionId(recipe));
      this.deps.onDiag?.('info', 'Import session discarded to start over', { kind: recipe.kind });
    }
    const opened = await this.deps.openImport(recipe);
    if (!opened.ok) throw new SessionError(404, `Not opened: ${opened.reason}`);
    return this.view();
  }
}
