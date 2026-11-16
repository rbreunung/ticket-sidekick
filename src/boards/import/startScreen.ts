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
  EMAIL_MODEL_SETTING, checkModelAnswers, describeEmailModels, emailModelInUse,
  type BoardModelInfo, type BoardModels, type EmailModelChoice, type ModelCheck, type ModelSettings,
} from '../boardModels';
import {
  REPORT_KINDS, REPORT_KIND_LABELS, emailRecipe, importSessionId, isReportKind, normaliseEmailPaths, normaliseReportPath,
  type ImportRecipe, type ReportKind,
} from './recipe';

// The start screen of an import: a tab without a session. The developer picks the report kind and
// the report file (for an email import, one or more `.eml` files); the template comes from `ticketSidekick.<kind>.template`, the issue type from
// that template and the project from `ticketSidekick.jira.defaultProject`. The template is asked
// for only when its setting is empty or names a template that is gone, and the choice is saved to
// the setting. The default project is picked the same way: when it is empty, not a project key or a
// project Jira does not have, the page asks for a key, typed or chosen from Jira's projects, checks
// it against Jira and saves it to the setting. Open hands the full recipe to the import board. vscode-free: the native file
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

/** How an email import's files are read on the start screen. */
export interface EmailFilesReader {
  /** The batch caps for this selection: the message to show, or null when the selection may be read. */
  checkCaps(filePaths: string[]): Promise<string | null>;
  /** Parses one file; throws with the reason it cannot be read. */
  read(filePath: string): Promise<unknown>;
}

export interface ImportStartDeps {
  /** The current Jira settings, plus a client when Jira is configured. */
  jira(): Promise<JiraAccess>;
  defaultProject(): string;
  templateSetting(kind: ReportKind): string;
  /** Saves the picked template to `ticketSidekick.<kind>.template`. */
  writeTemplateSetting(kind: ReportKind, name: string): Promise<void>;
  /** Saves the picked project to `ticketSidekick.jira.defaultProject`. */
  writeDefaultProject(key: string): Promise<void>;
  /** The templates of `.jira-templates.json`; throws when the file cannot be read. */
  templates(): JiraTemplate[];
  reportReader(kind: ReportKind): ReportReader;
  /** VS Code's native open dialog; undefined when it was cancelled. */
  pickReportFile(kind: ReportKind, filter: ReportReader['fileFilter']): Promise<string | undefined>;
  /** The open dialog for one or more `.eml` files; undefined when it was cancelled. */
  pickEmailFiles(): Promise<string[] | undefined>;
  emailFiles: EmailFilesReader;
  /** The models a board may call, and the two model settings; without them the email import shows no model. */
  models?: BoardModels;
  modelSettings?: ModelSettings;
  /** Opens VS Code's Settings at this setting. */
  openSetting(key: string): Promise<void>;
  hasSession(id: string): Promise<boolean>;
  discardSession(id: string): Promise<void>;
  /** Opens the import board with the full recipe; `title` is the opened board's tab title. */
  openImport(recipe: ImportRecipe): Promise<{ ok: true; title?: string } | { ok: false; reason: string }>;
  onDiag?: DiagLogger;
}

export interface StartScreenView {
  kind: ReportKind;
  kinds: Array<{ id: ReportKind; label: string }>;
  /**
   * The report file, or an email import's files: `paths` lists every file, `fileName` names the one
   * file or the count, `items` is the number of emails that read, and `skipped` names the ones that did not.
   */
  report: { path?: string; paths?: string[]; fileName?: string; items?: number; problem?: string; skipped?: string[] };
  /**
   * The default project. `askReason` and `options` (Jira's projects, as suggestions for a typed key)
   * are present while one must be given: the setting is empty, not a key, or names a project Jira
   * does not have. `listWarning` says the list could not be read. `problem` is the notice the page
   * shows with Open Setting while Jira is not set up.
   */
  project: { key?: string; problem?: string; options?: Array<{ key: string; name: string }>; askReason?: string; listWarning?: string };
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
  /**
   * An email import's model for the boilerplate check: the one in use and where it comes from, the
   * models to pick from, and the result of the one-call check after a pick. Not needed to open the import.
   */
  emailModel?: EmailModelChoice & { settingKey: string; check?: { ok: boolean; message: string } };
  /** The Jira setup hint, shown instead of Open while Jira is not configured. */
  jiraHint?: string;
  /** An import of this file in this project is stored already: Open shows it as it is, Start over begins again. */
  stored: boolean;
  canOpen: boolean;
  /** What stops Open, when something does. */
  blocker?: string;
}

type ReportResult = { items: number; skipped?: string[] } | { problem: string };

interface StartState {
  kind: ReportKind;
  reportPath?: string;
  /** An email import's files, normalised and sorted; `reportPath` is the first. */
  reportPaths?: string[];
  /** The emails were dragged into the chat: that counts as agreeing to the model check. Dropped when other files are chosen. */
  emailConsent?: boolean;
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
  /** The models available, once listed; listed again after a pick. */
  private modelList?: BoardModelInfo[];
  /** The last one-call check of a model, shown until another model is picked or checked. */
  private modelCheck?: ModelCheck;
  /** Jira's project list, once read; a failed read is tried again on the next view. */
  private projectList?: Array<{ key: string; name: string }>;

  constructor(private readonly deps: ImportStartDeps) {}

  /** Starts on a kind and a report file the board was asked for with; anything else in the input is ignored. */
  prefill(input: unknown): void {
    const v = (typeof input === 'object' && input !== null ? input : {}) as { kind?: unknown; reportPath?: unknown; reportPaths?: unknown; emailConsent?: unknown };
    if (!isReportKind(v.kind)) return;
    if (v.kind !== this.state.kind) this.state = { kind: v.kind };
    if (v.kind === 'email') {
      const files = Array.isArray(v.reportPaths) ? v.reportPaths : [v.reportPath];
      const absolute = files.filter((f): f is string => typeof f === 'string' && path.isAbsolute(f));
      if (absolute.length > 0) {
        this.setEmails(absolute);
        if (v.emailConsent === true) this.state.emailConsent = true;
      }
      return;
    }
    if (typeof v.reportPath === 'string' && path.isAbsolute(v.reportPath)) this.setReport(v.reportPath);
  }

  /**
   * Opens the import board for the kind and file it was prefilled with, when nothing is missing: the file reads, the
   * template and issue type are known and the project is set. Opens nothing otherwise, so the caller shows the start
   * screen with what is filled in. A stored import of the same file and project opens as it is.
   */
  async openIfReady(): Promise<{ opened: true; title?: string } | { opened: false }> {
    const view = await this.view();
    if (!view.canOpen) return { opened: false };
    const opened = await this.deps.openImport(this.recipeOf(view));
    if (!opened.ok) {
      this.deps.onDiag?.('warn', 'The import board did not open; showing the start screen', { kind: view.kind, reason: opened.reason });
      return { opened: false };
    }
    return { opened: true, ...(opened.title ? { title: opened.title } : {}) };
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
        if (kind === 'email') {
          const files = await this.deps.pickEmailFiles();
          if (files && files.length > 0 && this.state.kind === 'email') this.setEmails(files);
          return this.view();
        }
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
      case 'project': {
        const key = normalizeProjectKey(stringOf(body.key, 'project'));
        const access = await this.deps.jira();
        if (!key || !access.configured) throw new SessionError(400, 'Invalid project.');
        // A key from Jira's list is taken as it is; a typed one is looked up, since a long list may be cut short.
        const list = await this.readProjectList(access);
        if (!list.options?.some(p => p.key === key)) {
          try {
            const project = await access.client.getProject(key);
            this.projects.set(key, project.issueTypes.filter(t => !t.subtask).map(t => t.name));
          } catch (err) {
            if (err instanceof JiraApiError && err.isNotFound) throw new SessionError(400, `Jira has no project ${key}, or you cannot see it.`);
            throw new SessionError(400, `The project ${key} could not be checked: ${errorText(err)}`);
          }
        }
        await this.deps.writeDefaultProject(key);
        this.deps.onDiag?.('info', 'Default project setting saved', { setting: DEFAULT_PROJECT_SETTING });
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
      case 'model': {
        const { models, modelSettings } = this.deps;
        if (!models || !modelSettings) throw new SessionError(404, 'Unknown request.');
        const id = stringOf(body.id, 'model');
        const list = await this.listModels();
        if (!('models' in list) || !list.models.some(m => m.id === id)) throw new SessionError(400, 'That model is not available.');
        await modelSettings.writeEmailModel(id);
        this.deps.onDiag?.('info', 'Email check model setting saved', { setting: EMAIL_MODEL_SETTING, modelId: id });
        this.modelCheck = await checkModelAnswers(models, id, this.deps.onDiag);
        return this.view();
      }
      case 'model-check': {
        const { models, modelSettings } = this.deps;
        const inUse = modelSettings ? emailModelInUse(modelSettings) : undefined;
        if (!models || !inUse) throw new SessionError(409, 'No model is set for the email check.');
        this.modelCheck = await checkModelAnswers(models, inUse.id, this.deps.onDiag);
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

  private async listModels(): Promise<{ models: BoardModelInfo[] } | { problem: string }> {
    if (this.modelList) return { models: this.modelList };
    try {
      this.modelList = await this.deps.models!.list();
      return { models: this.modelList };
    } catch (err) {
      this.deps.onDiag?.('warn', 'Could not list the language models on the import start screen', { error: errorText(err) });
      return { problem: errorText(err) };
    }
  }

  /** The email import's model row: what is in use, what can be picked, and the last check. */
  private async emailModelView(): Promise<StartScreenView['emailModel']> {
    const { models, modelSettings } = this.deps;
    if (!models || !modelSettings) return undefined;
    const view: NonNullable<StartScreenView['emailModel']> = { settingKey: EMAIL_MODEL_SETTING, ...describeEmailModels(await this.listModels(), modelSettings) };
    const inUse = view.inUse;
    if (this.modelCheck && (!inUse || this.modelCheck.modelId === inUse.id)) {
      view.check = this.modelCheck.ok
        ? { ok: true, message: 'The model answered.' }
        : { ok: false, message: `The model did not answer: ${this.modelCheck.error}` };
    }
    return view;
  }

  private setEmails(filePaths: string[]): void {
    const reportPaths = normaliseEmailPaths(filePaths);
    // Agreeing by dragging covers the dragged emails only.
    delete this.state.emailConsent;
    this.state.reportPaths = reportPaths;
    this.state.reportPath = reportPaths[0];
    this.reports.delete(this.emailKey(reportPaths));
  }

  private emailKey(reportPaths: string[]): string {
    return ['email', ...reportPaths].join('\n');
  }

  /** Reads an email selection: the caps first, then each file; the files that do not read are named and left out. */
  private async readEmails(reportPaths: string[]): Promise<ReportResult> {
    const key = this.emailKey(reportPaths);
    const known = this.reports.get(key);
    if (known) return known;
    let result: ReportResult;
    const capProblem = await this.deps.emailFiles.checkCaps(reportPaths);
    if (capProblem) {
      result = { problem: capProblem };
    } else {
      const skipped: string[] = [];
      let items = 0;
      for (const filePath of reportPaths) {
        try {
          await this.deps.emailFiles.read(filePath);
          items++;
        } catch (err) {
          this.deps.onDiag?.('warn', 'Could not read an email on the import start screen', { fileName: path.basename(filePath), error: errorText(err) });
          skipped.push(`${path.basename(filePath)}: ${errorText(err)}`);
        }
      }
      result = items > 0
        ? { items, ...(skipped.length > 0 ? { skipped } : {}) }
        : { problem: `None of the selected emails could be read: ${skipped.join('; ')}` };
    }
    this.reports.set(key, result);
    return result;
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

  /** Jira's projects by key, for the pick; `error` when they cannot be read. */
  private async readProjectList(access: JiraAccess & { configured: true }): Promise<{ options?: Array<{ key: string; name: string }>; error?: string }> {
    if (this.projectList) return { options: this.projectList };
    try {
      const listed = await access.client.listProjects();
      this.projectList = listed.map(p => ({ key: p.key, name: p.name })).sort((a, b) => a.key.localeCompare(b.key));
      return { options: this.projectList };
    } catch (err) {
      this.deps.onDiag?.('warn', 'Could not list the Jira projects on the import start screen', { error: errorText(err) });
      return { error: errorText(err) };
    }
  }

  /**
   * A project to type or choose: the reason, Jira's projects as suggestions, and a warning when the
   * list could not be read (the key is typed then). Without Jira only the notice is shown.
   */
  private async askProject(access: JiraAccess, reason: string): Promise<{ problem?: string; options?: Array<{ key: string; name: string }>; askReason?: string; listWarning?: string }> {
    if (!access.configured) return { problem: reason };
    const list = await this.readProjectList(access);
    return {
      options: list.options ?? [],
      askReason: `${reason} Type the key of the project the tickets go to, or choose it from Jira's projects; it is saved to ${DEFAULT_PROJECT_SETTING}.`,
      ...(list.error ? { listWarning: `The list of Jira projects could not be read (${list.error}); type the key.` } : {}),
    };
  }

  /** The project and its issue types: read from Jira when it is configured and the key is well formed. */
  private async readProject(access: JiraAccess): Promise<{ key?: string; problem?: string; options?: Array<{ key: string; name: string }>; askReason?: string; listWarning?: string; issueTypes?: string[]; issueTypeError?: string }> {
    const value = this.deps.defaultProject().trim();
    if (!value) return this.askProject(access, `No default project is set in ${DEFAULT_PROJECT_SETTING}.`);
    const key = normalizeProjectKey(value);
    if (!key) return this.askProject(access, defaultProjectWarning({ kind: 'malformed', value }) ?? '');
    if (!access.configured) return { key };
    const known = this.projects.get(key);
    if (known) return { key, issueTypes: known };
    try {
      const project = await access.client.getProject(key);
      const issueTypes = project.issueTypes.filter(t => !t.subtask).map(t => t.name);
      this.projects.set(key, issueTypes);
      return { key, issueTypes };
    } catch (err) {
      if (err instanceof JiraApiError && err.isNotFound) return this.askProject(access, defaultProjectWarning({ kind: 'not-found', project: key }) ?? '');
      this.deps.onDiag?.('warn', `Could not fetch issue types — ${key}, you'll be asked to type it`, { projectKey: key, error: errorText(err) });
      return { key, issueTypeError: errorText(err) };
    }
  }

  async view(): Promise<StartScreenView> {
    const { kind, reportPath, reportPaths } = this.state;
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
    if (kind === 'email' && reportPaths && reportPaths.length > 0) {
      report.path = reportPaths[0];
      report.paths = reportPaths;
      report.fileName = reportPaths.length === 1 ? path.basename(reportPaths[0]) : `${reportPaths.length} emails`;
      const read = await this.readEmails(reportPaths);
      if ('items' in read) {
        report.items = read.items;
        if (read.skipped) report.skipped = read.skipped;
      } else {
        report.problem = read.problem;
      }
    } else if (reportPath && kind !== 'email') {
      report.path = reportPath;
      report.fileName = path.basename(reportPath);
      const read = await this.readReport(kind, reportPath);
      if ('items' in read) report.items = read.items;
      else report.problem = read.problem;
    }

    const stored = project.key && report.path
      ? await this.deps.hasSession(importSessionId({ kind, projectKey: project.key, reportPath: report.path, ...(report.paths ? { reportPaths: report.paths } : {}) }))
      : false;

    const blocker = jiraHint
      ?? project.problem
      ?? (project.askReason ? 'Type or choose a project.' : undefined)
      ?? template.problem
      ?? (!report.path ? (kind === 'email' ? 'Choose the email files.' : 'Choose the report file.') : undefined)
      ?? report.problem
      ?? (!template.name ? 'Pick a template.' : undefined)
      ?? (!issueType.name ? 'Pick an issue type.' : undefined);
    return {
      kind,
      kinds: REPORT_KINDS.map(id => ({ id, label: REPORT_KIND_LABELS[id] })),
      report,
      project: {
        ...(project.key ? { key: project.key } : {}), ...(project.problem ? { problem: project.problem } : {}),
        ...(project.askReason ? { options: project.options ?? [], askReason: project.askReason, ...(project.listWarning ? { listWarning: project.listWarning } : {}) } : {}),
      },
      template, issueType,
      ...(kind === 'email' ? { emailModel: await this.emailModelView() } : {}),
      ...(jiraHint ? { jiraHint } : {}),
      stored,
      canOpen: blocker === undefined,
      ...(blocker ? { blocker } : {}),
    };
  }

  /** The recipe of a view that can open. */
  private recipeOf(view: StartScreenView): ImportRecipe {
    if (view.kind === 'email') {
      return emailRecipe({
        projectKey: view.project.key as string, templateName: view.template.name as string, issueType: view.issueType.name as string,
        ...(this.state.emailConsent ? { emailConsent: true } : {}),
      }, view.report.paths as string[]);
    }
    return {
      kind: view.kind,
      projectKey: view.project.key as string,
      reportPath: view.report.path as string,
      templateName: view.template.name as string,
      issueType: view.issueType.name as string,
    };
  }

  private async open(startOver: boolean): Promise<StartScreenView> {
    const view = await this.view();
    if (!view.canOpen) throw new SessionError(409, view.blocker ?? 'The import cannot be opened yet.');
    const recipe = this.recipeOf(view);
    if (startOver) {
      await this.deps.discardSession(importSessionId(recipe));
      this.deps.onDiag?.('info', 'Import session discarded to start over', { kind: recipe.kind });
    }
    const opened = await this.deps.openImport(recipe);
    if (!opened.ok) throw new SessionError(404, `Not opened: ${opened.reason}`);
    return this.view();
  }
}
