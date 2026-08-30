import { describe, it, expect, afterEach } from 'vitest';
import { resolve, join } from 'path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { TemplateService, JiraTemplate } from '../templates/TemplateService';

const VALID_ROOT = resolve(process.cwd(), 'src/test/fixtures/templates-valid');
const BROKEN_ROOT = resolve(process.cwd(), 'src/test/fixtures/templates-broken');

const NEW_TEMPLATE: JiraTemplate = {
  name: 'New Template',
  issueType: 'Task',
  defaultFields: { priority: 'Low' },
  descriptionSections: ['Summary'],
};

describe('TemplateService', () => {
  it('returns both templates from a valid file', () => {
    const { templates } = new TemplateService(VALID_ROOT).loadTemplates();
    expect(templates).toHaveLength(2);
    expect(templates[0].name).toBe('Billing App Bug');
    expect(templates[1].name).toBe('Frontend Story');
  });

  it('returns defaultFields from template', () => {
    const { templates } = new TemplateService(VALID_ROOT).loadTemplates();
    expect(templates[0].defaultFields).toEqual({ priority: 'High', labels: ['billing'] });
  });

  it('returns issueType when specified in template', () => {
    const { templates } = new TemplateService(VALID_ROOT).loadTemplates();
    expect(templates[0].issueType).toBe('Bug');
  });

  it('leaves issueType undefined when omitted from template', () => {
    const { templates } = new TemplateService(VALID_ROOT).loadTemplates();
    expect(templates[1].issueType).toBeUndefined();
  });

  it('returns descriptionSections from template', () => {
    const { templates } = new TemplateService(VALID_ROOT).loadTemplates();
    expect(templates[0].descriptionSections).toEqual([
      'Steps to reproduce', 'Expected behavior', 'Actual behavior', 'Environment',
    ]);
  });

  it('returns empty array when file is absent', () => {
    const result = new TemplateService('/nonexistent/path').loadTemplates();
    expect(result).toEqual({ templates: [], cleanupRules: [] });
  });

  it('throws with clear message for invalid JSON', () => {
    const service = new TemplateService(BROKEN_ROOT);
    expect(() => service.loadTemplates()).toThrow('Could not parse .jira-templates.json');
  });

  it('returns cleanupRules from config', () => {
    const { cleanupRules } = new TemplateService(VALID_ROOT).loadTemplates();
    expect(cleanupRules).toHaveLength(1);
    expect(cleanupRules[0].name).toBe('Close released bugs');
    expect(cleanupRules[0].resolution).toBe('Fixed');
  });

  it('returns empty cleanupRules when absent', () => {
    const { cleanupRules } = new TemplateService('/nonexistent').loadTemplates();
    expect(cleanupRules).toEqual([]);
  });
});

describe('saveTemplate', () => {
  let workspaceRoot: string;

  afterEach(() => {
    if (workspaceRoot) {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('writes a new template to a workspace with no existing .jira-templates.json', () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'ts-template-'));
    const service = new TemplateService(workspaceRoot);

    const result = service.saveTemplate(NEW_TEMPLATE);

    expect(result).toEqual({ status: 'saved', template: NEW_TEMPLATE });
    const filePath = join(workspaceRoot, '.jira-templates.json');
    const written = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(written.templates).toEqual([NEW_TEMPLATE]);
    expect(written.cleanupRules).toEqual([]);
  });

  it('appends a new template to an existing file without altering other entries', () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'ts-template-'));
    const filePath = join(workspaceRoot, '.jira-templates.json');
    const existingContent = {
      templates: [
        { name: 'Existing Bug', issueType: 'Bug', defaultFields: { priority: 'High' } },
      ],
      cleanupRules: [
        { name: 'Close released bugs', project: 'PROJ', issueType: 'Bug', targetState: 'Done' },
      ],
    };
    writeFileSync(filePath, JSON.stringify(existingContent, null, 2), 'utf-8');
    const service = new TemplateService(workspaceRoot);

    const result = service.saveTemplate(NEW_TEMPLATE);

    expect(result).toEqual({ status: 'saved', template: NEW_TEMPLATE });
    const written = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(written.templates).toHaveLength(2);
    expect(written.templates[0]).toEqual(existingContent.templates[0]);
    expect(written.templates[1]).toEqual(NEW_TEMPLATE);
    expect(written.cleanupRules).toEqual(existingContent.cleanupRules);
  });

  it('detects a name collision and reports it instead of overwriting silently', () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'ts-template-'));
    const filePath = join(workspaceRoot, '.jira-templates.json');
    const existingTemplate: JiraTemplate = {
      name: 'New Template',
      issueType: 'Bug',
      defaultFields: { priority: 'High' },
    };
    writeFileSync(filePath, JSON.stringify({ templates: [existingTemplate], cleanupRules: [] }, null, 2), 'utf-8');
    const service = new TemplateService(workspaceRoot);

    const result = service.saveTemplate(NEW_TEMPLATE);

    expect(result).toEqual({ status: 'collision', existing: existingTemplate });
    // File is untouched by the collision attempt.
    const written = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(written.templates).toEqual([existingTemplate]);
  });

  it('overwrites the existing template when overwrite is explicitly confirmed', () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'ts-template-'));
    const filePath = join(workspaceRoot, '.jira-templates.json');
    const existingTemplate: JiraTemplate = {
      name: 'New Template',
      issueType: 'Bug',
      defaultFields: { priority: 'High' },
    };
    writeFileSync(filePath, JSON.stringify({ templates: [existingTemplate], cleanupRules: [] }, null, 2), 'utf-8');
    const service = new TemplateService(workspaceRoot);

    const result = service.saveTemplate(NEW_TEMPLATE, { overwrite: true });

    expect(result).toEqual({ status: 'saved', template: NEW_TEMPLATE });
    const written = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(written.templates).toEqual([NEW_TEMPLATE]);
  });

  it('round-trips through loadTemplates after a save', () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'ts-template-'));
    const service = new TemplateService(workspaceRoot);

    service.saveTemplate(NEW_TEMPLATE);
    const { templates } = service.loadTemplates();

    expect(templates).toEqual([NEW_TEMPLATE]);
  });

  it('throws with a clear message when the write fails', () => {
    // Point at a subdirectory that does not exist, so writeFileSync fails with ENOENT.
    workspaceRoot = mkdtempSync(join(tmpdir(), 'ts-template-'));
    const unwritableRoot = join(workspaceRoot, 'missing-subdir');
    const service = new TemplateService(unwritableRoot);

    expect(() => service.saveTemplate(NEW_TEMPLATE)).toThrow('Could not write .jira-templates.json');
  });
});
