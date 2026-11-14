import { describe, it, expect } from 'vitest';
import { JIRA_COMMAND_ENTRIES, JIRA_HELP_GROUPS, buildJiraHelp } from '../participant/sessionState';

describe('buildJiraHelp', () => {
  const help = buildJiraHelp('0.8.4');

  it('opens with the tool name and version and closes with the help sentence', () => {
    const lines = help.split('\n');
    expect(lines[0]).toBe('**Ticket Sidekick `@jira` · v0.8.4 — Help**');
    expect(lines[lines.length - 1]).toBe('`help` prints this list again.');
    expect(help).toContain('`@jira` now only imports reports');
  });

  it('lists the groups in order, each with at least one bullet', () => {
    const positions = JIRA_HELP_GROUPS.map(g => help.indexOf(`**${g}**`));
    expect(positions.every(p => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const group of JIRA_HELP_GROUPS) {
      expect(JIRA_COMMAND_ENTRIES.some(e => e.group === group)).toBe(true);
    }
  });

  it('renders flat code-span bullets and no markdown links', () => {
    const bullets = help.split('\n').filter(l => l.startsWith('- '));
    expect(bullets.length).toBe(JIRA_COMMAND_ENTRIES.length);
    for (const bullet of bullets) {
      expect(bullet).toMatch(/`[^`]+`/);
    }
    expect(help).not.toMatch(/\]\(/);
    expect(help).not.toContain('command:');
  });

  it('lists only the report imports', () => {
    expect(JIRA_COMMAND_ENTRIES.map(e => e.id)).toEqual(['email', 'veracode', 'waltz']);
    expect(help).not.toContain('/security-report');
  });

  it('keeps the version text inert', () => {
    const title = buildJiraHelp('1.0.0`](x)\n- injected').split('\n')[0];
    expect(title).toBe('**Ticket Sidekick `@jira` · v1.0.0x-injected — Help**');
    expect(title).not.toMatch(/\]\(/);
    expect(buildJiraHelp('unknown').split('\n')[0]).toContain('vunknown');
  });
});
