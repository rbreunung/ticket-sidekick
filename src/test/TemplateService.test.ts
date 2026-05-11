import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { TemplateService } from '../templates/TemplateService';

const VALID_ROOT = resolve(process.cwd(), 'src/test/fixtures/templates-valid');
const BROKEN_ROOT = resolve(process.cwd(), 'src/test/fixtures/templates-broken');

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
