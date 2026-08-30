import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface ResolveSpec {
  type: 'sprint' | 'team' | 'user';
  name?: string;
  id?: string | number;
}

export interface JiraTemplate {
  name: string;
  issueType?: string;
  defaultFields: Record<string, unknown>;
  resolveFields?: Record<string, ResolveSpec | ResolveSpec[]>;
  descriptionSections?: string[];
}

export interface CleanupRule {
  name: string;
  project: string;
  issueType: string;
  targetState: string;
  resolution?: string;
  closeSubtasks?: boolean;
  subtaskResolution?: string;
  subtaskTargetState?: string;
  jql?: string;
  fixVersionFilter?: 'released' | 'unreleased';
  fixVersionPattern?: string;
}

export type SaveTemplateResult =
  | { status: 'saved'; template: JiraTemplate }
  | { status: 'collision'; existing: JiraTemplate };

export class TemplateService {
  constructor(private readonly workspaceRoot: string) {}

  /**
   * Saves a new template into .jira-templates.json, mirroring
   * WorkflowService.ts's writeFileSync/JSON.stringify(..., null, 2) pattern.
   *
   * Never silently overwrites an existing template with the same name: if one
   * is found, returns a 'collision' result instead of writing, unless the
   * caller passes { overwrite: true } (used once the user explicitly confirms).
   */
  saveTemplate(template: JiraTemplate, options?: { overwrite?: boolean }): SaveTemplateResult {
    const filePath = join(this.workspaceRoot, '.jira-templates.json');
    const { templates, cleanupRules } = this.loadTemplates();

    const existingIndex = templates.findIndex((t) => t.name === template.name);
    if (existingIndex !== -1 && !options?.overwrite) {
      return { status: 'collision', existing: templates[existingIndex] };
    }

    const nextTemplates =
      existingIndex !== -1
        ? templates.map((t, i) => (i === existingIndex ? template : t))
        : [...templates, template];

    try {
      writeFileSync(filePath, JSON.stringify({ templates: nextTemplates, cleanupRules }, null, 2), 'utf-8');
    } catch (err) {
      throw new Error(`Could not write .jira-templates.json: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { status: 'saved', template };
  }

  loadTemplates(): { templates: JiraTemplate[]; cleanupRules: CleanupRule[] } {
    const filePath = join(this.workspaceRoot, '.jira-templates.json');
    if (!existsSync(filePath)) return { templates: [], cleanupRules: [] };
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (err) {
      throw new Error(`Could not read .jira-templates.json: ${err instanceof Error ? err.message : String(err)}`);
    }
    let parsed: { templates?: JiraTemplate[]; cleanupRules?: CleanupRule[] };
    try {
      parsed = JSON.parse(raw) as { templates?: JiraTemplate[]; cleanupRules?: CleanupRule[] };
    } catch (err) {
      throw new Error(`Could not parse .jira-templates.json: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { templates: parsed.templates ?? [], cleanupRules: parsed.cleanupRules ?? [] };
  }
}
