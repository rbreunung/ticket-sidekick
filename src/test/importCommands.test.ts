import { describe, it, expect } from 'vitest';
import {
  buildCommandsLine, buildImportHelp, buildRefusedReply, commandEntriesFor, type ImportCommandCaps,
} from '../participant/sessionState';

const waltz: ImportCommandCaps = {
  canFold: true, canAccept: true, canMergeTickets: true, canExport: true, canSearch: true,
  actionLabels: { 'follow-up': 'new ticket' }, ticketedActions: ['rewrite', 'follow-up', 'leave'],
};
const veracode: ImportCommandCaps = { ...waltz, canAccept: false, actionLabels: undefined, ticketedActions: undefined };
const email: ImportCommandCaps = { canFold: false, canAccept: false, canMergeTickets: false, canExport: false, canSearch: false };

describe('Commands line', () => {
  it('lists search and both accept words on a Waltz New screen', () => {
    const line = buildCommandsLine('new', waltz);
    expect(line).toMatch(/^Commands: rows `2 4` · group `merge` `unmerge` `add … to KEY` · hide `accept CVE` `accept component` · find `search` · /);
    expect(line).toContain('help');
  });

  it('lists no accept words for Veracode and no search for an importer without ticket search', () => {
    expect(buildCommandsLine('new', veracode)).not.toContain('accept');
    expect(buildCommandsLine('new', veracode)).toContain('`search`');
    expect(buildCommandsLine('new', email)).not.toContain('search');
    expect(buildCommandsLine('new', email)).not.toContain('merge');
  });

  it('keeps show, the paging words and the typed export forms out of the line', () => {
    const line = buildCommandsLine('new', waltz);
    for (const word of ['show', 'next', 'prev', 'export', 'create tickets']) expect(line).not.toContain(`\`${word}`);
  });

  it('shows only the help link on the overview', () => {
    const line = buildCommandsLine('overview', waltz);
    expect(line).not.toContain('Commands:');
    expect(line).toContain('help');
  });

  it("names the importer's own row actions on Already ticketed and only those some row offers", () => {
    const line = buildCommandsLine('ticketed', waltz);
    expect(line).toContain('`A2 new ticket`');
    expect(line).toContain('`A2 rewrite`');
    expect(line).not.toContain('follow-up');
    expect(line).not.toContain('re-create');
    expect(line).toContain('tickets `merge A5 into A3` `search`');
    expect(line).toContain('hide `accept component`');
  });

  it('lists the ticket keys to toggle on Stale and nothing else', () => {
    expect(buildCommandsLine('stale', waltz)).toMatch(/^Commands: toggle `PROJ-123` · /);
  });

  it('lists the email preview commands, dropping model check, row ids and save when they have nothing to act on', () => {
    const full = buildCommandsLine('email-preview', { emailRows: 3, emailCanModelCheck: true, emailCanSave: true });
    expect(full).toMatch(/clean up `strip` `keep` `model check` · rows `3` · patterns `save <n>`/);
    const bare = buildCommandsLine('email-preview', { emailRows: 1 });
    expect(bare).toContain('`strip` `keep`');
    expect(bare).not.toContain('model check');
    expect(bare).not.toContain('rows');
    expect(bare).not.toContain('save');
  });
});

describe('help', () => {
  it('explains every command the line lists, plus the ones the line leaves out', () => {
    const help = buildImportHelp('new', waltz);
    for (const word of ['accept CVE', 'accept component', 'search netty', 'merge 2 4', 'show', 'include all', 'next', 'accepted', 'create tickets']) {
      expect(help).toContain(word);
    }
    expect(help).toMatch(/^\*\*Help — New screen\*\*/);
  });

  it('puts the notes about paging on the screen that needs them', () => {
    expect(buildImportHelp('ticketed', waltz)).toContain('actions apply to rows on every page');
    expect(buildImportHelp('stale', waltz)).toContain('tickets marked on any page are closed together');
  });

  it('lists the typed export forms on a group screen only for a single-group import, and always on the overview', () => {
    expect(buildImportHelp('new', { ...waltz, singleGroup: false })).not.toContain('export csv');
    expect(buildImportHelp('new', { ...waltz, singleGroup: true })).toContain('export csv');
    expect(buildImportHelp('overview', { ...waltz, singleGroup: false })).toContain('export xlsx');
  });

  it('leaves out the shortcut runs no row offers', () => {
    const help = buildImportHelp('ticketed', waltz);
    expect(help).not.toContain('update tickets');
    expect(help).not.toContain('re-create tickets');
    expect(buildImportHelp('ticketed', veracode)).toContain('re-create tickets');
  });

  it('never lists an entry whose capability the importer lacks', () => {
    const ids = commandEntriesFor('new', email).map(e => e.id);
    expect(ids).not.toContain('search');
    expect(ids).not.toContain('accept-cve');
    expect(ids).not.toContain('fold');
  });
});

describe('refused reply', () => {
  it('quotes what was typed once and then prints the screen help', () => {
    const reply = buildRefusedReply({ view: 'new', caps: waltz, typed: '2x' });
    expect(reply.startsWith("I didn't understand `2x`.")).toBe(true);
    expect(reply).toContain('**Help — New screen**');
  });

  it('shows the specific reason, not a quote, before the help', () => {
    const reply = buildRefusedReply({ view: 'new', caps: waltz, typed: '9', reason: "Row 9 isn't a New row on this page, so it can't be accepted." });
    expect(reply.startsWith("Row 9 isn't a New row on this page")).toBe(true);
    expect(reply).not.toContain("I didn't understand");
    expect(reply).toContain('**Help — New screen**');
  });

  it('keeps a pasted link inert and cannot break out of the code span', () => {
    const reply = buildRefusedReply({ view: 'new', caps: waltz, typed: '[x](command:workbench.action.chat.open) `evil`' });
    const lead = reply.split('\n\n')[0];
    expect(lead).not.toContain('`evil`');
    expect(lead).toBe("I didn't understand `[x](command:workbench.action.chat.open) 'evil'`.");
  });

  it('defuses link brackets in a parser reason', () => {
    const reply = buildRefusedReply({ view: 'new', caps: waltz, reason: 'Row [A](command:x) is not a row.' });
    expect(reply.split('\n\n')[0]).toBe('Row ［A］(command:x) is not a row.');
  });

  it('caps a very long reply and flattens line breaks', () => {
    const lead = buildRefusedReply({ view: 'new', caps: waltz, typed: `${'a'.repeat(300)}\nsecond` }).split('\n\n')[0];
    expect(lead).toBe(`I didn't understand \`${'a'.repeat(80)}…\`.`);
  });

  it('falls back to a plain sentence when nothing was typed', () => {
    expect(buildRefusedReply({ view: 'stale', caps: waltz }).startsWith("I didn't understand that.")).toBe(true);
  });
});
