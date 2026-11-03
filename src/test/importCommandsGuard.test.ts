import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  IMPORT_COMMAND_ENTRIES, commandEntriesFor, buildCommandsLine, buildImportHelp, importCommandCaps, parseImportReviewReply, parseEmailCleanupReply,
  type CommandView, type ImportCommandCaps, type ImportReplyAction, type ImportReplyContext, type TicketedAction,
} from '../participant/sessionState';

// Guard for the command catalog: what a screen's Commands line and help list must match
// what its reply parser accepts, so a reply word cannot be added to a parser and go unadvertised the way `search` once did.
// src/test is outside the compile project, so the exhaustive record below is also checked against the parser's source.

/** Every reply kind the review parsers can return, and the catalog entry that covers it. */
const KIND_ENTRY: Record<ImportReplyAction['kind'], string> = {
  open: 'open', done: 'exit', back: 'exit', create: 'create', update: 'run', recreate: 'run', apply: 'run',
  setAction: 'row-action', setAllActions: 'all-action', close: 'close', pageNav: 'paging', bulk: 'bulk',
  merge: 'fold', unmerge: 'fold', addPrompt: 'fold', add: 'fold',
  accept: 'accept-cve', acceptComponent: 'accept-component', listAccepted: 'accepted-list', unaccept: 'accepted-list', unacceptEntry: 'accepted-list', unacceptComponent: 'accepted-list',
  mergeTicketsPrompt: 'merge-tickets', mergeTickets: 'merge-tickets', reloadPrompt: 'reload', reload: 'reload',
  export: 'export', search: 'search', show: 'show', help: 'help', toggleRows: 'toggle-rows', toggleStale: 'toggle-stale',
  invalid: '(a refusal, not a command)',
};

/** The email cleanup preview's reply actions, likewise. `skip-model` exists on the consent screen only. */
const EMAIL_ACTION_ENTRY: Record<string, string> = {
  'model-check': 'email-model-check', 'skip-model': '(consent screen only)', strip: 'email-strip', keep: 'email-keep',
  toggle: 'email-rows', save: 'email-save', cancel: 'email-cancel', help: 'help', invalid: '(a refusal, not a command)',
};

const sourceOf = (file: string): string => readFileSync(resolve(process.cwd(), file), 'utf-8');
const ids = new Set(IMPORT_COMMAND_ENTRIES.map(e => e.id));

const ALL_ACTIONS: TicketedAction[] = ['update', 'follow-up', 'rewrite', 're-create', 'leave'];
const stale = { groups: [{ issueType: 'Bug', rules: [], graph: {} as never, tickets: [{ key: 'PROJ-1', summary: 's', currentStatus: 'Open', transitionPath: [], subtasks: [], included: false }] }], ineligible: [], resolutionOptions: [] };

interface Profile { name: string; flags: Partial<ImportReplyContext> }
const PROFILES: Profile[] = [
  { name: 'Waltz', flags: { canFold: true, canAccept: true, canMergeTickets: true, canExport: true, canSearch: true, actionLabels: { 'follow-up': 'new ticket' } } },
  { name: 'Veracode', flags: { canFold: true, canMergeTickets: true, canExport: true, canSearch: true } },
  { name: 'email', flags: {} },
];

function contextFor(profile: Profile, singleGroup: boolean): ImportReplyContext {
  const offered: TicketedAction[] = profile.flags.actionLabels ? ['rewrite', 'follow-up', 'leave'] : ALL_ACTIONS;
  return {
    singleGroup, groups: ['new', 'ticketed', 'stale'], newRowIds: ['1', '2', '3', '4'],
    ticketedRows: [{ id: 'A1', allowedActions: offered }, { id: 'A2', allowedActions: offered }],
    stale, mergedRowIds: ['3'], ticketTargetKeys: { a1: 'PROJ-5', a2: 'PROJ-6' }, ...profile.flags,
  };
}

const VIEWS: Array<'overview' | 'new' | 'ticketed' | 'stale'> = ['overview', 'new', 'ticketed', 'stale'];

describe('every reply kind the parsers can return has a catalog entry', () => {
  it('lists exactly the kinds declared in ImportReplyAction', () => {
    const source = sourceOf('src/participant/session/importReplies.ts');
    const block = source.slice(source.indexOf('export type ImportReplyAction ='), source.indexOf('export interface ImportReplyContext'));
    const declared = [...block.matchAll(/\{ kind: '(\w+)'/g)].map(m => m[1]).sort();
    expect(declared.length).toBeGreaterThan(20);
    expect(Object.keys(KIND_ENTRY).sort()).toEqual(declared);
  });

  it('maps each kind to an entry that names it', () => {
    for (const [kind, id] of Object.entries(KIND_ENTRY)) {
      if (id.startsWith('(')) continue;
      expect(ids.has(id), `${kind} → ${id}`).toBe(true);
      expect(IMPORT_COMMAND_ENTRIES.find(e => e.id === id)!.kinds, `${id} covers ${kind}`).toContain(kind);
    }
  });

  it('covers the email preview actions the same way', () => {
    const source = sourceOf('src/participant/session/emailCleanup.ts');
    const block = source.slice(source.indexOf('export type EmailCleanupReply ='), source.indexOf('// Replies per phase.'));
    const declared = [...block.matchAll(/action: '([\w-]+)'/g)].map(m => m[1]).sort();
    expect(Object.keys(EMAIL_ACTION_ENTRY).sort()).toEqual(declared);
    for (const [action, id] of Object.entries(EMAIL_ACTION_ENTRY)) {
      if (id.startsWith('(')) continue;
      expect(IMPORT_COMMAND_ENTRIES.find(e => e.id === id)!.kinds, `${id} covers ${action}`).toContain(action);
    }
  });
});

describe.each(PROFILES)('$name review: what each screen lists is what its parser accepts', (profile) => {
  for (const singleGroup of [false, true]) {
    for (const view of VIEWS) {
      it(`${view} screen${singleGroup ? ' of a single-group import' : ''}`, () => {
        const ctx = contextFor(profile, singleGroup);
        const caps = importCommandCaps(ctx);
        const entries = commandEntriesFor(view, caps);
        expect(entries.length).toBeGreaterThan(0);

        for (const entry of entries) {
          for (const sample of entry.samples(caps, view)) {
            const action = parseImportReviewReply(view, sample, ctx);
            expect(action.kind, `"${sample}" (${entry.id}) must be accepted on ${view}`).not.toBe('invalid');
            expect(entry.kinds, `"${sample}" parsed as ${action.kind}, which ${entry.id} must name`).toContain(action.kind);
          }
        }

        // The line and the help come from the same entries, and every entry with a line is explained in help.
        const help = buildImportHelp(view, caps);
        for (const entry of entries) expect(help).toContain(entry.help(caps, view));
        const line = buildCommandsLine(view, caps);
        for (const entry of entries.filter(e => e.line)) {
          for (const name of entry.line!(caps, view)) expect(line, `${entry.id} → ${name}`).toContain(`\`${name}\``);
        }
        // Words that need the screen's own state never appear in a line for another importer.
        if (!profile.flags.canSearch) expect(line + help).not.toContain('search');
        if (!profile.flags.canAccept) expect(line + help).not.toContain('accept');
      });
    }
  }
});

describe('email cleanup preview: what it lists is what its parser accepts', () => {
  const caps: ImportCommandCaps = { emailRows: 3, emailModelCheckCount: 2, emailCanSave: true };

  it('every sample is accepted and named by its entry', () => {
    const entries = commandEntriesFor('email-preview', caps);
    expect(entries.map(e => e.id)).toEqual(expect.arrayContaining(['email-strip', 'email-keep', 'email-model-check', 'email-rows', 'email-save', 'email-cancel', 'help']));
    for (const entry of entries) {
      for (const sample of entry.samples(caps, 'email-preview' as CommandView)) {
        const action = parseEmailCleanupReply(sample, 'preview', ['1', '2', '3']);
        expect(action.action, `"${sample}" (${entry.id})`).not.toBe('invalid');
        expect(entry.kinds, `"${sample}" parsed as ${action.action}`).toContain(action.action);
      }
    }
  });

  it('drops the entries that have nothing to act on', () => {
    const ids = commandEntriesFor('email-preview', { emailRows: 1 }).map(e => e.id);
    expect(ids).not.toContain('email-model-check');
    expect(ids).not.toContain('email-rows');
    expect(ids).not.toContain('email-save');
  });
});
