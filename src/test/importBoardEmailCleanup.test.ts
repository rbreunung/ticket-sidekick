import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardModels } from '../boards/boardModels';
import type { CleanupView } from '../boards/import/cleanupStage';
import { importKind, type ImportView, type ImportWorking } from '../boards/import/kind';
import type { ImportData, ImportDeps } from '../boards/import/read';
import { emailRecipe, importSessionId, type ImportRecipe } from '../boards/import/recipe';
import type { Session, WritePlan } from '../sessions/sessionTypes';
import type { BoilerplatePattern } from '../utils/emailBoilerplate';
import { EmptyProjectJira, emlFile, emptyProjectImportDeps } from './helpers/importBoardFixture';

// The boilerplate cleanup of an email import on the board: patterns first; the model only after the
// developer agreed through a preview that names every email and the model; then strip or keep.

let dir: string;
let jira: EmptyProjectJira;
let deps: ImportDeps;
let patterns: BoilerplatePattern[];
let savedPatterns: BoilerplatePattern[];
let modelSettings: { email: string; review: string };
let sent: Array<{ id: string; prompt: string }>;
let reply: (prompt: string) => string | Promise<string>;
let logs: Array<[string, string, unknown]>;

const models: BoardModels = {
  list: async () => [{ id: 'm1', name: 'Model One', vendor: 'copilot', family: 'one' }],
  send: async (id, prompt) => { sent.push({ id, prompt }); return reply(prompt); },
};

const DISCLAIMER = 'CONFIDENTIAL: this message is for the addressee only.';
const SIGNATURE = 'Best regards\nAnn Example\nSupport lead';

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ts-import-cleanup-'));
  jira = new EmptyProjectJira();
  patterns = [{ kind: 'footer', start: 'CONFIDENTIAL:' }];
  savedPatterns = [];
  modelSettings = { email: '', review: '' };
  sent = [];
  logs = [];
  reply = () => '{"blocks":[]}';
  deps = {
    ...emptyProjectImportDeps(dir, jira),
    boilerplatePatterns: () => patterns,
    savePattern: async p => { savedPatterns.push(p); },
    models,
    modelSettings: {
      emailModel: () => modelSettings.email,
      reviewModel: () => modelSettings.review,
      writeEmailModel: async id => { modelSettings.email = id; },
    },
    onDiag: (level, message, details) => { logs.push([level, message, details]); },
  };
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

type ImportSession = Session<ImportRecipe, ImportData, ImportWorking>;

async function openEmails(files: string[]): Promise<ImportSession> {
  const r = emailRecipe({ projectKey: 'PROJ', templateName: 'Security bug', issueType: 'Bug' }, files);
  const validated = await importKind.validate(r, deps);
  if (!validated.ok) throw new Error(validated.reason);
  return {
    id: importSessionId(r), kind: 'import', formatVersion: importKind.formatVersion, revision: 1, createdAt: 0, lastUsedAt: 0,
    recipe: validated.recipe, derived: await importKind.read(validated.recipe, deps), working: importKind.initialWorking(validated.recipe), conflicts: [],
  };
}

const view = (session: ImportSession): ImportView => importKind.view(session);
const cleanup = (session: ImportSession): CleanupView => view(session).ext['email-cleanup'] as CleanupView;

function act(session: ImportSession, action: unknown): ImportSession {
  const reduced = importKind.reduce(session, action as never);
  if (!reduced.ok) throw new Error(reduced.reason);
  return { ...session, working: reduced.working };
}

function plan(session: ImportSession, action: unknown): WritePlan {
  const planned = importKind.plan!(session, action as never);
  if (!planned.ok) throw new Error(planned.reason);
  return planned.plan;
}

async function apply(session: ImportSession, p: WritePlan) {
  const applied = await importKind.apply!(session, p, deps);
  return { applied, session: { ...session, derived: applied.derived, working: applied.working } };
}

function rowId(session: ImportSession, fileName: string): string {
  return cleanup(session).rows.find(r => r.ref === fileName)!.id;
}

describe('patterns', () => {
  it('finds a pattern block, shows it, and strips it from the ticket while the file stays as it is', async () => {
    const a = emlFile(dir, 'a.eml', 'Login fails', { body: `The login page fails.\n\n${DISCLAIMER}` });
    let session = await openEmails([a]);
    expect(cleanup(session).phase).toBe('preview');
    expect(cleanup(session).rows[0].blocks).toEqual([expect.objectContaining({ kind: 'footer', source: 'pattern', savable: false })]);
    expect(sent).toEqual([]);
    expect(importKind.plan!(session, { type: 'new-create' } as never)).toEqual({ ok: false, reason: expect.stringMatching(/Finish the email cleanup first/) });

    session = act(session, { type: 'cleanup-strip' });
    expect(cleanup(session).phase).toBe('done');
    await apply(session, plan(session, { type: 'new-create' }));
    const description = String(jira.createIssueCalls[0].additionalFields!.description);
    expect(description).toContain('The login page fails.');
    expect(description).not.toContain('CONFIDENTIAL');
    expect(fs.readFileSync(a, 'utf8')).toContain('CONFIDENTIAL');
  });

  it('keeps everything on keep, and then lets the tickets be created', async () => {
    const a = emlFile(dir, 'a.eml', 'One', { body: `Body one.\n\n${DISCLAIMER}` });
    let session = await openEmails([a]);
    expect(cleanup(session).phase).toBe('preview');
    session = act(session, { type: 'cleanup-keep' });
    expect(cleanup(session).phase).toBe('done');
    await apply(session, plan(session, { type: 'new-create' }));
    expect(String(jira.createIssueCalls[0].additionalFields!.description)).toContain('CONFIDENTIAL');
  });

  it('asks again when an email changed on disk after the strip, so its old cleaned body is never written', async () => {
    const a = emlFile(dir, 'a.eml', 'One', { body: `Body one.\n\n${DISCLAIMER}` });
    let session = await openEmails([a]);
    session = act(session, { type: 'cleanup-strip' });
    expect(cleanup(session).phase).toBe('done');
    emlFile(dir, 'a.eml', 'Two', { body: `Body two.\n\n${DISCLAIMER}` });
    const fresh = await importKind.read(session.recipe, deps);
    session = { ...session, ...importKind.reconcile(session, fresh, 'refresh') };
    expect(cleanup(session).phase).toBe('preview');
    session = act(session, { type: 'cleanup-strip' });
    await apply(session, plan(session, { type: 'new-create' }));
    const description = String(jira.createIssueCalls[0].additionalFields!.description);
    expect(description).toContain('Body two.');
    expect(description).not.toContain('Body one.');
  });

  it('leaves an email out of the strip when it is unticked', async () => {
    const a = emlFile(dir, 'a.eml', 'One', { body: `Body one.\n\n${DISCLAIMER}` });
    const b = emlFile(dir, 'b.eml', 'Two', { body: `Body two.\n\n${DISCLAIMER}` });
    let session = await openEmails([a, b]);
    session = act(session, { type: 'cleanup-exclude', id: rowId(session, 'b.eml'), excluded: true });
    session = act(session, { type: 'cleanup-strip' });
    await apply(session, plan(session, { type: 'new-create' }));
    const [one, two] = jira.createIssueCalls.map(c => String(c.additionalFields!.description));
    expect(one).not.toContain('CONFIDENTIAL');
    expect(two).toContain('CONFIDENTIAL');
  });

  it('opens the New tab at once when nothing is found and nothing has to be asked', async () => {
    const session = await openEmails([emlFile(dir, 'a.eml', 'Empty', { body: '' })]);
    expect(cleanup(session).phase).toBe('done');
  });
});

describe('consent and the model check', () => {
  it('asks before any call, and continues without the model when the developer says no', async () => {
    let session = await openEmails([emlFile(dir, 'a.eml', 'Login fails')]);
    expect(cleanup(session)).toMatchObject({ phase: 'consent', toCheck: 1 });
    session = act(session, { type: 'cleanup-skip' });
    expect(cleanup(session).phase).toBe('done');
    expect(cleanup(session).rows[0].status).toBe('declined');
    expect(sent).toEqual([]);
  });

  it('asks for a model when none is set, names every email and the model in the preview, and saves the pick', async () => {
    let session = await openEmails([emlFile(dir, 'a.eml', 'Login fails', { body: `The login page fails.\n\n${SIGNATURE}` })]);
    expect(importKind.plan!(session, { type: 'cleanup-check' } as never)).toEqual({ ok: false, reason: 'Pick the model that checks the emails first.' });
    const p = plan(session, { type: 'cleanup-check', modelId: 'm1' });
    expect(p.lines).toEqual([
      { target: 'a.eml', change: 'Send the text of "Login fails" to Model One (copilot)' },
      { target: 'ticketSidekick.email.checkModel', change: 'Save Model One (copilot) as the model of the email check' },
    ]);
    expect(sent).toEqual([]);

    reply = () => JSON.stringify({ blocks: [{ kind: 'signature', startQuote: 'Best regards', endQuote: 'Support lead', authorName: 'Ann Example' }] });
    ({ session } = await apply(session, p));
    expect(modelSettings.email).toBe('m1');
    expect(sent.map(s => s.id)).toEqual(['m1']);
    expect(cleanup(session).phase).toBe('preview');
    expect(cleanup(session).rows[0]).toMatchObject({ status: 'checked', modelId: 'm1' });
    expect(cleanup(session).rows[0].blocks).toEqual([expect.objectContaining({ kind: 'signature', source: 'model', savable: true })]);
    // The next import uses the saved model without asking.
    expect(cleanup(await openEmails([emlFile(dir, 'b.eml', 'Other')])).model?.inUse).toMatchObject({ id: 'm1', source: 'email' });
  });

  it('logs the model and the counts of a check, never the email text or the reply', async () => {
    modelSettings.review = 'm1';
    const session = await openEmails([emlFile(dir, 'a.eml', 'Secret subject', { body: 'Very secret body text' })]);
    reply = () => '{"blocks":[{"kind":"footer","startQuote":"Very secret","endQuote":"body text"}]}';
    await apply(session, plan(session, { type: 'cleanup-check' }));
    const logged = JSON.stringify(logs);
    expect(logged).toContain('Email model check done');
    expect(logged).not.toContain('secret');
  });

  it('marks an email whose check failed, keeps its blocks, and offers it again', async () => {
    modelSettings.review = 'm1';
    const session = await openEmails([
      emlFile(dir, 'a.eml', 'One'),
      emlFile(dir, 'b.eml', 'Two', { body: `Body two.\n\n${DISCLAIMER}` }),
    ]);
    reply = () => { throw Object.assign(new Error('blocked'), { code: 'Blocked' }); };
    const { session: after, applied } = await apply(session, plan(session, { type: 'cleanup-check' }));
    expect(applied.results.map(r => r.outcome)).toEqual(['failed']);
    expect(cleanup(after).phase).toBe('preview');
    expect(cleanup(after).rows.map(r => r.status)).toEqual(['failed', 'not-needed']);
    expect(cleanup(after).toCheck).toBe(2);
  });

  it('keeps the emails a check did not reach when the work stops part way, and asks for them again', async () => {
    modelSettings.review = 'm1';
    const files = ['a', 'b', 'c', 'd', 'e'].map(n => emlFile(dir, `${n}.eml`, `Mail ${n}`));
    const session = await openEmails(files);
    let saved: ImportWorking | undefined;
    let calls = 0;
    reply = () => { calls++; if (calls > 2) throw new Error('VS Code closed'); return '{"blocks":[]}'; };
    await importKind.apply!(session, plan(session, { type: 'cleanup-check' }), deps, async report => { if (report.done === 2) saved = report.working; });
    const restored: ImportSession = { ...session, working: saved! };
    expect(cleanup(restored).phase).toBe('consent');
    expect(cleanup(restored).rows.map(r => r.status)).toEqual(['checked', 'checked', 'awaiting-consent', 'awaiting-consent', 'awaiting-consent']);
    expect(cleanup(restored).toCheck).toBe(3);
  });

  it('never sends an email over the size limit', async () => {
    modelSettings.review = 'm1';
    const session = await openEmails([emlFile(dir, 'big.eml', 'Huge', { body: 'x'.repeat(30001) })]);
    expect(cleanup(session).rows[0].status).toBe('too-long');
    expect(cleanup(session).phase).toBe('done');
  });

  it('makes no model call when the emails are read again', async () => {
    modelSettings.review = 'm1';
    const session = await openEmails([emlFile(dir, 'a.eml', 'One')]);
    const fresh = await importKind.read(session.recipe, deps);
    importKind.reconcile(session, fresh, 'refresh');
    expect(sent).toEqual([]);
  });

  it('saves a block the model found as a pattern', async () => {
    modelSettings.review = 'm1';
    let session = await openEmails([emlFile(dir, 'a.eml', 'Login fails', { body: `The login page fails.\n\n${SIGNATURE}` })]);
    reply = () => JSON.stringify({ blocks: [{ kind: 'signature', startQuote: 'Best regards', endQuote: 'Support lead' }] });
    ({ session } = await apply(session, plan(session, { type: 'cleanup-check' })));
    const block = cleanup(session).rows[0].blocks[0];
    ({ session } = await apply(session, plan(session, { type: 'cleanup-save', block: block.id })));
    expect(savedPatterns).toEqual([expect.objectContaining({ kind: 'signature', start: 'Best regards' })]);
    expect(cleanup(session).rows[0].blocks[0]).toMatchObject({ saved: true, savable: false });
  });
});
