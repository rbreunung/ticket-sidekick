import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { TemplateService } from '../templates/TemplateService';

const VALID_ROOT = resolve(process.cwd(), 'src/test/fixtures/templates-valid');
const BROKEN_ROOT = resolve(process.cwd(), 'src/test/fixtures/templates-broken');

describe('TemplateService', () => {
  it('returns both templates from a valid file', () => {
    const service = new TemplateService(VALID_ROOT);
    const templates = service.loadTemplates();
    expect(templates).toHaveLength(2);
    expect(templates[0].name).toBe('Billing App Bug');
    expect(templates[1].name).toBe('Frontend Story');
  });

  it('returns defaultFields from template', () => {
    const templates = new TemplateService(VALID_ROOT).loadTemplates();
    expect(templates[0].defaultFields).toEqual({ priority: 'High', labels: ['billing'] });
  });

  it('returns descriptionSections from template', () => {
    const templates = new TemplateService(VALID_ROOT).loadTemplates();
    expect(templates[0].descriptionSections).toEqual([
      'Steps to reproduce', 'Expected behavior', 'Actual behavior', 'Environment',
    ]);
  });

  it('returns empty array when file is absent', () => {
    const service = new TemplateService('/nonexistent/path');
    expect(service.loadTemplates()).toEqual([]);
  });

  it('throws with clear message for invalid JSON', () => {
    const service = new TemplateService(BROKEN_ROOT);
    expect(() => service.loadTemplates()).toThrow('Could not parse .jira-templates.json');
  });
});
