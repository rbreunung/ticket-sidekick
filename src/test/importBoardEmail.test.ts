import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importKind, type ImportView, type ImportWorking } from '../boards/import/kind';
import type { ImportData, ImportDeps } from '../boards/import/read';
import { emailRecipe, importSessionId, type ImportRecipe } from '../boards/import/recipe';
import type { Session, WritePlan } from '../sessions/sessionTypes';
import { EmptyProjectJira, emlFile, emptyProjectImportDeps } from './helpers/importBoardFixture';

// An email import on the import board: one New row per email, a ticket or a comment for each, with
// the attachments read from the email's file at the write, since the session keeps none of them.

let dir: string;
let jira: EmptyProjectJira;
let deps: ImportDeps;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ts-import-email-'));
  jira = new EmptyProjectJira();
  deps = emptyProjectImportDeps(dir, jira);
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

type ImportSession = Session<ImportRecipe, ImportData, ImportWorking>;

async function openEmails(files: string[], importDeps = deps): Promise<ImportSession> {
  const r = emailRecipe({ projectKey: 'PROJ', templateName: 'Security bug', issueType: 'Bug' }, files);
  const validated = await importKind.validate(r, importDeps);
  if (!validated.ok) throw new Error(validated.reason);
  return {
    id: importSessionId(r), kind: 'import', formatVersion: importKind.formatVersion, revision: 1, createdAt: 0, lastUsedAt: 0,
    recipe: validated.recipe, derived: await importKind.read(validated.recipe, importDeps), working: importKind.initialWorking(validated.recipe), conflicts: [],
  };
}

const view = (session: ImportSession): ImportView => importKind.view(session);

function rowId(session: ImportSession, fileName: string): string {
  const row = view(session).new!.rows.find(r => r.ref === fileName);
  if (!row) throw new Error(`No New row for ${fileName}`);
  return row.id;
}

function act(session: ImportSession, action: unknown): ImportSession {
  const reduced = importKind.reduce(session, action as never);
  if (!reduced.ok) throw new Error(reduced.reason);
  return { ...session, working: reduced.working };
}

async function plan(session: ImportSession, action: unknown, importDeps = deps): Promise<WritePlan> {
  const prepared = importKind.prepare ? await importKind.prepare(session, action as never, importDeps) : undefined;
  const planned = importKind.plan!(session, action as never, prepared);
  if (!planned.ok) throw new Error(planned.reason);
  return planned.plan;
}

async function apply(session: ImportSession, p: WritePlan, importDeps = deps) {
  const applied = await importKind.apply!(session, p, importDeps);
  return { applied, session: { ...session, derived: applied.derived, working: applied.working } };
}

describe('reading an email import', () => {
  it('shows one New row per email, names a file that is not an email, and has no other tab', async () => {
    const a = emlFile(dir, 'a.eml', 'Login fails');
    const b = emlFile(dir, 'b.eml', 'Export is slow', { attachment: 'log.txt' });
    // A folder where an email file was: it is there but does not read.
    const broken = path.join(dir, 'broken.eml');
    fs.mkdirSync(broken);
    const session = await openEmails([a, b, broken]);
    const v = view(session);
    expect(v.title).toBe('Email import: 3 emails');
    expect(v.tabs.map(t => t.id)).toEqual(['new']);
    expect(v.new!.rows.map(r => [r.ref, r.summary])).toEqual([['a.eml', 'Login fails'], ['b.eml', 'Export is slow']]);
    expect(v.notices.join(' ')).toMatch(/Could not read 1 email file\(s\): broken\.eml/);
  });

  it('keeps no attachment content in the stored session', async () => {
    const big = emlFile(dir, 'big.eml', 'Large log', { attachment: 'big.txt' });
    const session = await openEmails([big]);
    expect(JSON.stringify(session.derived)).not.toContain(Buffer.from('log line').toString('base64'));
  });

  it('marks the New tab out of date when an email file changes on disk', async () => {
    const a = emlFile(dir, 'a.eml', 'Login fails');
    let session = await openEmails([a]);
    session = act(session, { type: 'new-include', ids: 'all', included: false });
    emlFile(dir, 'a.eml', 'Login fails again');
    const fresh = await importKind.read(session.recipe, deps);
    const reconciled = importKind.reconcile(session, fresh, 'background');
    expect(reconciled.working.outOfDate).toEqual(['new']);
  });
});

describe('creating tickets from emails', () => {
  it('creates one ticket per email with its subject and uploads its attachment read from the file again', async () => {
    const a = emlFile(dir, 'a.eml', 'Login fails');
    const b = emlFile(dir, 'b.eml', 'Export is slow', { attachment: 'log.txt' });
    const session = await openEmails([a, b]);
    const p = await plan(session, { type: 'new-create' });
    expect(p.risky).toBe(true);
    const { applied, session: after } = await apply(session, p);
    expect(applied.results.map(r => r.outcome)).toEqual(['done', 'done']);
    expect(jira.createIssueCalls.map(c => c.summary)).toEqual(['Login fails', 'Export is slow']);
    expect(jira.uploadAttachmentCalls).toEqual([{ issueKey: 'PROJ-101', filename: 'log.txt', contentType: 'text/plain' }]);
    expect(view(after).finished).toBe(true);
  });

  it('refuses an email whose file is gone and still creates the others', async () => {
    const a = emlFile(dir, 'a.eml', 'Login fails');
    const b = emlFile(dir, 'b.eml', 'Export is slow');
    const session = await openEmails([a, b]);
    const p = await plan(session, { type: 'new-create' });
    fs.rmSync(b);
    const { applied } = await apply(session, p);
    expect(applied.results.map(r => r.outcome)).toEqual(['done', 'refused']);
    expect(applied.results[1].reason).toMatch(/b\.eml is no longer there.*Pick the file again/);
    expect(jira.createIssueCalls.map(c => c.summary)).toEqual(['Login fails']);
  });

  it('deletes the .eml after creating its ticket when the setting is on, without naming it as missing afterwards', async () => {
    const deleting = emptyProjectImportDeps(dir, jira, { deleteEmlAfterImport: true });
    const a = emlFile(dir, 'a.eml', 'Login fails');
    const b = emlFile(dir, 'b.eml', 'Export is slow');
    let session = await openEmails([a, b], deleting);
    session = act(session, { type: 'new-include', ids: [rowId(session, 'b.eml')], included: false });
    const { session: after } = await apply(session, await plan(session, { type: 'new-create' }, deleting), deleting);
    expect(fs.existsSync(a)).toBe(false);
    const fresh = await importKind.read(after.recipe, deleting);
    const refreshed = importKind.reconcile(after, fresh, 'refresh');
    expect(view({ ...after, ...refreshed }).notices.join(' ')).not.toMatch(/no longer there/);
  });

  it('says on the created line that an attachment did not upload, and keeps the .eml', async () => {
    const deleting = emptyProjectImportDeps(dir, jira, { deleteEmlAfterImport: true });
    const a = emlFile(dir, 'a.eml', 'Login fails', { attachment: 'log.txt' });
    jira.uploadAttachment = async () => { throw new Error('too large'); };
    const session = await openEmails([a], deleting);
    const { applied } = await apply(session, await plan(session, { type: 'new-create' }, deleting), deleting);
    expect(applied.results.map(r => r.outcome)).toEqual(['done']);
    expect(applied.results[0].reason).toMatch(/Uploaded 0 of 1 attachment\(s\); failed: log\.txt: too large\. The \.eml file was kept\./);
    expect(fs.existsSync(a)).toBe(true);
  });

  it('stays finished when the board deleted every email file after creating their tickets', async () => {
    const deleting = emptyProjectImportDeps(dir, jira, { deleteEmlAfterImport: true });
    const a = emlFile(dir, 'a.eml', 'Login fails');
    const session = await openEmails([a], deleting);
    const { session: after } = await apply(session, await plan(session, { type: 'new-create' }, deleting), deleting);
    expect(fs.existsSync(a)).toBe(false);
    const fresh = await importKind.read(after.recipe, deleting);
    const refreshed = importKind.reconcile(after, fresh, 'refresh');
    expect(view({ ...after, ...refreshed }).notices.join(' ')).not.toMatch(/no longer there/);
  });

  it('is not found when every email file is gone and the board deleted none of them', async () => {
    const a = emlFile(dir, 'a.eml', 'Login fails');
    const session = await openEmails([a]);
    fs.rmSync(a);
    const fresh = await importKind.read(session.recipe, deps);
    expect(() => importKind.reconcile(session, fresh, 'refresh')).toThrow(/a\.eml/);
  });

  it('refuses an email whose file changed since the board read it', async () => {
    const a = emlFile(dir, 'a.eml', 'Login fails', { attachment: 'log.txt' });
    const session = await openEmails([a]);
    const p = await plan(session, { type: 'new-create' });
    emlFile(dir, 'a.eml', 'Another email saved under the same name', { attachment: 'other.txt' });
    const { applied } = await apply(session, p);
    expect(applied.results.map(r => r.outcome)).toEqual(['refused']);
    expect(applied.results[0].reason).toMatch(/a\.eml changed since the board read it.*Refresh/);
    expect(jira.createIssueCalls).toHaveLength(0);
  });

  it('does not merge emails', async () => {
    const session = await openEmails([emlFile(dir, 'a.eml', 'One'), emlFile(dir, 'b.eml', 'Two')]);
    const reduced = importKind.reduce(session, { type: 'new-merge', ids: [rowId(session, 'a.eml'), rowId(session, 'b.eml')] } as never);
    expect(reduced).toEqual({ ok: false, reason: expect.stringMatching(/not merged/) });
  });
});

describe('adding an email to an existing ticket', () => {
  it('posts the email as a comment with the sender and date, uploads its attachment and keeps the .eml', async () => {
    const deleting = emptyProjectImportDeps(dir, jira, { deleteEmlAfterImport: true });
    const a = emlFile(dir, 'a.eml', 'Login fails', { attachment: 'log.txt' });
    const session = await openEmails([a], deleting);
    const p = await plan(session, { type: 'new-add', ids: [rowId(session, 'a.eml')], key: 'PROJ-42', mode: 'comment' }, deleting);
    expect(p.lines.at(-1)!.change).toBe('Post the email "Login fails" as a comment and upload its 1 attachment');
    const { applied, session: after } = await apply(session, p, deleting);
    expect(applied.results.map(r => r.outcome)).toEqual(['done']);
    expect(jira.addCommentCalls).toHaveLength(1);
    expect(jira.addCommentCalls[0].issueKey).toBe('PROJ-42');
    expect(jira.addCommentCalls[0].body).toMatch(/^\*From:\* Ann Example {2}· {2}\*Date:\* 2026-11-16\n\nThe login page fails\./);
    expect(jira.uploadAttachmentCalls).toEqual([{ issueKey: 'PROJ-42', filename: 'log.txt', contentType: 'text/plain' }]);
    expect(fs.existsSync(a)).toBe(true);
    expect(view(after).ext.new).toMatchObject({ addedTo: { [rowId(session, 'a.eml')]: 'PROJ-42' } });
  });

  it('refuses a rewrite', async () => {
    const session = await openEmails([emlFile(dir, 'a.eml', 'Login fails')]);
    const planned = importKind.plan!(session, { type: 'new-add', ids: [rowId(session, 'a.eml')], key: 'PROJ-42', mode: 'rewrite' } as never);
    expect(planned).toEqual({ ok: false, reason: 'An email is added to a ticket as a comment.' });
  });
});

describe('likely repeats', () => {
  it('marks an email whose subject is a ticket\'s summary, leaves it out and offers that ticket', async () => {
    jira.tickets['PROJ-42'] = { labels: [], summary: 'Login fails' };
    jira.tickets['PROJ-43'] = { labels: [], summary: 'Login fails on Monday' };
    let session = await openEmails([emlFile(dir, 'a.eml', 'RE: Login fails'), emlFile(dir, 'b.eml', 'Export is slow')]);
    const rows = view(session).new!.rows;
    expect(rows.map(r => [r.ref, r.included, r.repeatOf?.map(t => t.key)])).toEqual([['a.eml', false, ['PROJ-42']], ['b.eml', true, undefined]]);
    expect(rows[0].repeatOf![0].url).toBe('https://jira.example.com/browse/PROJ-42');

    // Creating takes only the other email; the repeat can still be taken in.
    expect((await plan(session, { type: 'new-create' })).lines.map(l => l.target)).toEqual(['b.eml']);
    session = act(session, { type: 'new-include', ids: [rowId(session, 'a.eml')], included: true });
    expect(view(session).new!.rows[0].included).toBe(true);
    expect((await plan(session, { type: 'new-create' })).lines).toHaveLength(2);
    session = act(session, { type: 'new-include', ids: 'all', included: false });
    expect(view(session).new!.rows.map(r => r.included)).toEqual([false, false]);
  });

  it('marks nothing and says so when the search fails, and still creates', async () => {
    jira.summarySearchFails = true;
    const session = await openEmails([emlFile(dir, 'a.eml', 'Login fails')]);
    const v = view(session);
    expect(v.notices.join(' ')).toMatch(/search for tickets with the same subject failed/);
    expect(v.new!.rows[0].included).toBe(true);
    const { applied } = await apply(session, await plan(session, { type: 'new-create' }));
    expect(applied.results.map(r => r.outcome)).toEqual(['done']);
  });
});
