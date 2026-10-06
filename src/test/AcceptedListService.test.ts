import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AcceptedListService } from '../services/AcceptedListService';
import { ACCEPTED_FILE_NAME } from '../utils/waltzAccepted';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'accepted-list-')); });
afterEach(() => { try { chmodSync(dir, 0o755); } catch { /* ignore */ } rmSync(dir, { recursive: true, force: true }); });

const file = () => join(dir, ACCEPTED_FILE_NAME);

describe('AcceptedListService.load', () => {
  it('reads a missing file as an empty list with no warning', () => {
    const loaded = new AcceptedListService(dir).load();
    expect(loaded.entries).toEqual([]);
    expect(loaded.warning).toBeNull();
  });

  it('reads an invalid file as an empty list with a warning and leaves the file untouched', () => {
    writeFileSync(file(), '{ "accepted": [');
    const loaded = new AcceptedListService(dir).load();
    expect(loaded.entries).toEqual([]);
    expect(loaded.warning).not.toBeNull();
    expect(readFileSync(file(), 'utf8')).toBe('{ "accepted": [');
  });
});

describe('AcceptedListService.add', () => {
  it('creates the file when it does not exist, in the hand-editable shape', () => {
    const result = new AcceptedListService(dir).add([{ component: 'libfoo', cve: 'CVE-2024-0001', reason: 'not reachable' }]);
    expect(result).toMatchObject({ ok: true, added: 1 });
    expect(readFileSync(file(), 'utf8')).toBe(
      '{\n  "accepted": [\n    {\n      "component": "libfoo",\n      "cve": "CVE-2024-0001",\n      "reason": "not reachable"\n    }\n  ]\n}\n',
    );
  });

  it('leaves the file content unchanged when the pair is already there', () => {
    const service = new AcceptedListService(dir);
    service.add([{ component: 'libfoo', cve: 'CVE-2024-0001' }]);
    const before = readFileSync(file(), 'utf8');
    const result = service.add([{ component: 'LIBFOO', cve: 'cve-2024-0001' }]);
    expect(result).toMatchObject({ ok: true, added: 0 });
    expect(readFileSync(file(), 'utf8')).toBe(before);
  });

  it('refuses to write over a file that is not valid JSON, so hand-kept entries survive', () => {
    writeFileSync(file(), '{ "accepted": [ ');
    const result = new AcceptedListService(dir).add([{ component: 'libfoo', cve: 'CVE-2024-0001' }]);
    expect(result.ok).toBe(false);
    expect(readFileSync(file(), 'utf8')).toBe('{ "accepted": [ ');
  });

  it('refuses to write over a file that has an entry it could not read, so no entry or extra key is lost', () => {
    const original = JSON.stringify({ accepted: [{ component: 'libfoo', cves: 'CVE-2024-0001' }, { component: 'libbar', cve: 'CVE-2024-0002', ticket: 'PROJ-9' }] });
    writeFileSync(file(), original);
    const service = new AcceptedListService(dir);
    expect(service.add([{ component: 'libnew', cve: 'CVE-2024-0003' }]).ok).toBe(false);
    expect(service.remove(1).ok).toBe(false);
    expect(readFileSync(file(), 'utf8')).toBe(original);
  });

  it('reports a failed write instead of throwing', () => {
    const result = new AcceptedListService(join(dir, 'missing-subdir')).add([{ component: 'libfoo', cve: 'CVE-2024-0001' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/could not write/i);
  });
});

describe('AcceptedListService.remove', () => {
  it('removes the entry at that position and keeps the rest', () => {
    const service = new AcceptedListService(dir);
    service.add([{ component: 'a', cve: 'CVE-1' }, { component: 'b', cve: 'CVE-2' }]);
    const result = service.remove(1);
    expect(result).toMatchObject({ ok: true, removed: { component: 'a', cve: 'CVE-1' } });
    expect(service.load().entries).toEqual([{ component: 'b', cve: 'CVE-2' }]);
  });

  it('leaves an empty but valid file after the last entry is removed', () => {
    const service = new AcceptedListService(dir);
    service.add([{ component: 'a', cve: 'CVE-1' }]);
    expect(service.remove(1).ok).toBe(true);
    expect(service.load()).toMatchObject({ entries: [], warning: null });
    expect(existsSync(file())).toBe(true);
  });

  it('fails for a position outside the list and writes nothing', () => {
    const service = new AcceptedListService(dir);
    service.add([{ component: 'a', cve: 'CVE-1' }]);
    const before = readFileSync(file(), 'utf8');
    expect(service.remove(2).ok).toBe(false);
    expect(readFileSync(file(), 'utf8')).toBe(before);
  });

  it('refuses to write over a file that is not valid JSON', () => {
    writeFileSync(file(), 'nope');
    expect(new AcceptedListService(dir).remove(1).ok).toBe(false);
    expect(readFileSync(file(), 'utf8')).toBe('nope');
  });
});
