import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface ResolveSpec {
  type: 'sprint' | 'team' | 'user';
  name?: string;
  id?: string | number;
}

export interface JiraTemplate {
  name: string;
  defaultFields: Record<string, unknown>;
  resolveFields?: Record<string, ResolveSpec | ResolveSpec[]>;
  descriptionSections: string[];
}

export class TemplateService {
  constructor(private readonly workspaceRoot: string) {}

  loadTemplates(): JiraTemplate[] {
    const filePath = join(this.workspaceRoot, '.jira-templates.json');
    if (!existsSync(filePath)) return [];
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (err) {
      throw new Error(`Could not read .jira-templates.json: ${err instanceof Error ? err.message : String(err)}`);
    }
    let parsed: { templates: JiraTemplate[] };
    try {
      parsed = JSON.parse(raw) as { templates: JiraTemplate[] };
    } catch (err) {
      throw new Error(`Could not parse .jira-templates.json: ${err instanceof Error ? err.message : String(err)}`);
    }
    return parsed.templates ?? [];
  }
}
