import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { JIRA_COMMAND_ENTRIES } from '../participant/sessionState';

// Guard for the top-level help: every slash command in package.json and every operation the intent parser can return
// must appear in a catalog entry, so a new one cannot ship without being advertised. src/test is outside the compile
// project, so the Operation union is read from the source text, like importCommandsGuard.test.ts does for its parsers.

const sourceOf = (file: string): string => readFileSync(resolve(process.cwd(), file), 'utf-8');

const covered = new Set(JIRA_COMMAND_ENTRIES.flatMap(e => e.covers));

describe('the @jira help catalog covers everything the participant offers', () => {
  it('has an entry for every slash command in package.json', () => {
    const pkg = JSON.parse(sourceOf('package.json')) as { contributes: { chatParticipants: Array<{ name: string; commands?: Array<{ name: string }> }> } };
    const commands = (pkg.contributes.chatParticipants.find(p => p.name === 'jira')?.commands ?? []).map(c => `/${c.name}`);
    expect(commands.length).toBeGreaterThan(5);
    expect(commands.filter(c => !covered.has(c)), 'add these slash commands to JIRA_COMMAND_ENTRIES').toEqual([]);
  });

  it('has an entry for every operation the intent parser can return', () => {
    const source = sourceOf('src/participant/jira/llmHelpers.ts');
    const block = source.slice(source.indexOf('export type Operation ='), source.indexOf('export interface FieldUpdate'));
    const operations = [...block.matchAll(/'(\w+)'/g)].map(m => m[1]);
    expect(operations.length).toBeGreaterThan(20);
    expect(operations.filter(o => !covered.has(o)), 'add these operations to JIRA_COMMAND_ENTRIES').toEqual([]);
  });

  it('names nothing the participant no longer offers', () => {
    const source = sourceOf('src/participant/jira/llmHelpers.ts');
    const pkg = sourceOf('package.json');
    const stale = [...covered].filter(name => (name.startsWith('/') ? !pkg.includes(`"name": "${name.slice(1)}"`) : !source.includes(`'${name}'`)));
    expect(stale).toEqual([]);
  });
});
