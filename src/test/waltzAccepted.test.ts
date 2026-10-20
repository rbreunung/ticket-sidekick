import { describe, it, expect } from 'vitest';
import {
  parseAcceptedFile, serializeAcceptedFile, componentNameOf, addAcceptedEntries, removeAcceptedEntry,
  narrowGroup, acceptedEntriesOf, removeAcceptedPair, type AcceptedEntry,
  componentVersionOf, acceptedComponentKeys, isComponentAccepted, acceptedComponentEntriesOf, removeAcceptedComponent,
} from '../utils/waltzAccepted';
import type { WaltzComponent } from '../utils/waltzReport';

function component(nameVersion: string, maxVulnRating: string, vulns: Array<[string, string | null]>): WaltzComponent {
  return {
    nameVersion,
    maxVulnRating,
    remediationAction: null,
    instancePaths: [],
    vulnerabilities: vulns.map(([cveId, overallSeverity]) => ({
      cveId, cveSummary: null, overallSeverity, cvssV3Score: null, fixedVersion: null,
    })),
  };
}

const accepted = (component: string, cve: string, reason?: string): AcceptedEntry =>
  (reason === undefined ? { component, cve } : { component, cve, reason });

describe('narrowGroup — what the New screen offers for a component', () => {
  it('drops an accepted CVE and rates the row by the CVE that is left (AE1)', () => {
    const group = [component('netty-codec:4.1.100', 'Critical', [['CVE-2024-0001', 'Critical'], ['CVE-2024-0002', 'High']])];
    const result = narrowGroup(group, [accepted('netty-codec', 'CVE-2024-0001')], 'High');
    expect(result.group).not.toBeNull();
    expect(result.group![0].vulnerabilities.map(v => v.cveId)).toEqual(['CVE-2024-0002']);
    expect(result.group![0].maxVulnRating).toBe('High');
    expect(result.hiddenCves).toBe(1);
    expect(result.belowFloor).toBe(0);
  });

  it('hides a component whose CVEs are all accepted and counts the CVEs (AE2)', () => {
    const group = [component('netty-codec:4.1.100', 'High', [['CVE-2024-0001', 'High'], ['CVE-2024-0002', 'High']])];
    const result = narrowGroup(group, [accepted('netty-codec', 'CVE-2024-0001'), accepted('netty-codec', 'CVE-2024-0002')], 'High');
    expect(result.group).toBeNull();
    expect(result.hiddenCves).toBe(2);
    expect(result.belowFloor).toBe(0);
  });

  it('matches by component name whatever the version (AE3)', () => {
    const entries = [accepted('netty-codec', 'CVE-2024-0001')];
    const newer = component('netty-codec:4.1.101', 'High', [['CVE-2024-0001', 'High']]);
    expect(narrowGroup([newer], entries, 'High').group).toBeNull();
    const otherLibrary = component('netty-codec-http:4.1.101', 'High', [['CVE-2024-0001', 'High']]);
    expect(narrowGroup([otherLibrary], entries, 'High').group).not.toBeNull();
  });

  it('hides a component that falls below the rating floor and reports it apart from accepted ones (AE5)', () => {
    const group = [component('libfoo:1.0', 'High', [['CVE-2024-0001', 'High'], ['CVE-2024-0002', 'Low']])];
    const result = narrowGroup(group, [accepted('libfoo', 'CVE-2024-0001')], 'High');
    expect(result.group).toBeNull();
    expect(result.hiddenCves).toBe(1);
    expect(result.belowFloor).toBe(1);
  });

  it('returns a component untouched when none of its CVEs is on the list, whatever its CVE severities say', () => {
    const group = [component('libfoo:1.0', 'Critical', [['CVE-2024-0001', 'Low']])];
    const result = narrowGroup(group, [accepted('other', 'CVE-2024-0001')], 'High');
    expect(result.group).toBe(group);
    expect(result.hiddenCves).toBe(0);
    expect(result.belowFloor).toBe(0);
  });

  it('returns a component untouched for an empty list', () => {
    const group = [component('libfoo:1.0', 'Critical', [['CVE-2024-0001', 'Low']])];
    expect(narrowGroup(group, [], 'High').group).toBe(group);
  });

  it('leaves a component with no CVE data alone', () => {
    const group = [component('libfoo:1.0', 'High', [])];
    expect(narrowGroup(group, [accepted('libfoo', 'CVE-2024-0001')], 'High').group).toBe(group);
  });

  it('keeps the report rating when the remaining CVEs carry no severity', () => {
    const group = [component('libfoo:1.0', 'Critical', [['CVE-2024-0001', 'High'], ['CVE-2024-0002', null]])];
    const result = narrowGroup(group, [accepted('libfoo', 'CVE-2024-0001')], 'High');
    expect(result.group![0].maxVulnRating).toBe('Critical');
  });

  it('matches component names and CVE ids regardless of case and surrounding spaces', () => {
    const group = [component('Netty-Codec:4.1.100', 'High', [['cve-2024-0001', 'High']])];
    expect(narrowGroup(group, [accepted(' netty-codec ', 'CVE-2024-0001')], 'High').group).toBeNull();
  });

  it('uses the whole nameVersion as the name when it has no colon', () => {
    const group = [component('standalone', 'High', [['CVE-2024-0001', 'High']])];
    expect(narrowGroup(group, [accepted('standalone', 'CVE-2024-0001')], 'High').group).toBeNull();
  });

  it('narrows each member of a merged group on its own and keeps the members that remain', () => {
    const group = [
      component('a:1.0', 'High', [['CVE-2024-0001', 'High']]),
      component('b:2.0', 'High', [['CVE-2024-0002', 'High'], ['CVE-2024-0003', 'High']]),
    ];
    const result = narrowGroup(group, [accepted('a', 'CVE-2024-0001'), accepted('b', 'CVE-2024-0002')], 'High');
    expect(result.group!.map(c => c.nameVersion)).toEqual(['b:2.0']);
    expect(result.group![0].vulnerabilities.map(v => v.cveId)).toEqual(['CVE-2024-0003']);
    expect(result.hiddenCves).toBe(2);
  });
});

describe('parseAcceptedFile — reading the hand-editable file', () => {
  it('reads entries with and without a reason', () => {
    const text = JSON.stringify({ accepted: [
      { component: 'netty-codec', cve: 'CVE-2024-0001', reason: 'not reachable' },
      { component: 'libfoo', cve: 'CVE-2024-0002' },
    ] });
    const parsed = parseAcceptedFile(text);
    expect(parsed.warning).toBeNull();
    expect(parsed.entries).toEqual([
      { component: 'netty-codec', cve: 'CVE-2024-0001', reason: 'not reachable' },
      { component: 'libfoo', cve: 'CVE-2024-0002' },
    ]);
  });

  it('treats invalid JSON as an empty list with a warning, and says it is unparseable', () => {
    const parsed = parseAcceptedFile('{ "accepted": [ ');
    expect(parsed.entries).toEqual([]);
    expect(parsed.unparseable).toBe(true);
    expect(parsed.warning).toMatch(/\.jira-oss-accepted\.json/);
  });

  it('skips an entry without a CVE and counts it in the warning', () => {
    const parsed = parseAcceptedFile(JSON.stringify({ accepted: [
      { component: 'libfoo' },
      { component: 'libfoo', cve: 'CVE-2024-0002' },
    ] }));
    expect(parsed.entries).toEqual([{ component: 'libfoo', cve: 'CVE-2024-0002' }]);
    expect(parsed.unparseable).toBe(false);
    expect(parsed.warning).toMatch(/1 entr/);
  });

  it('treats a file without an accepted array as unparseable', () => {
    const parsed = parseAcceptedFile(JSON.stringify({ other: [] }));
    expect(parsed.entries).toEqual([]);
    expect(parsed.unparseable).toBe(true);
  });
});

describe('editing the list', () => {
  it('adds new pairs and ignores pairs already on the list', () => {
    const existing = [accepted('libfoo', 'CVE-2024-0001', 'known')];
    const { entries, added } = addAcceptedEntries(existing, [accepted('LibFoo', 'cve-2024-0001'), accepted('libbar', 'CVE-2024-0002')]);
    expect(added).toBe(1);
    expect(entries).toEqual([accepted('libfoo', 'CVE-2024-0001', 'known'), accepted('libbar', 'CVE-2024-0002')]);
  });

  it('removes an entry by its 1-based position and keeps the others in order', () => {
    const existing = [accepted('a', 'CVE-1'), accepted('b', 'CVE-2'), accepted('c', 'CVE-3')];
    const result = removeAcceptedEntry(existing, 2);
    expect(result!.removed).toEqual(accepted('b', 'CVE-2'));
    expect(result!.entries).toEqual([accepted('a', 'CVE-1'), accepted('c', 'CVE-3')]);
  });

  it('removes an entry by component and CVE whatever its position, ignoring case and spaces', () => {
    const existing = [accepted('a', 'CVE-1'), accepted('b', 'CVE-2'), accepted('c', 'CVE-3')];
    const result = removeAcceptedPair(existing, ' B ', 'cve-2');
    expect(result!.removed).toEqual(accepted('b', 'CVE-2'));
    expect(result!.entries).toEqual([accepted('a', 'CVE-1'), accepted('c', 'CVE-3')]);
  });

  it('matches a component whose stored name has inner whitespace runs the way a Remove link spells it', () => {
    const existing = [accepted('lib  with   gaps', 'CVE-1')];
    expect(removeAcceptedPair(existing, 'lib with gaps', 'CVE-1')!.entries).toEqual([]);
  });

  it('removes every copy of a pair a hand edit listed twice, so the CVE really is offered again', () => {
    const existing = [accepted('a', 'CVE-1'), accepted('A', 'cve-1', 'again'), accepted('b', 'CVE-2')];
    const result = removeAcceptedPair(existing, 'a', 'CVE-1');
    expect(result!.entries).toEqual([accepted('b', 'CVE-2')]);
  });

  it('removes nothing for a pair that is not on the list', () => {
    expect(removeAcceptedPair([accepted('a', 'CVE-1')], 'a', 'CVE-2')).toBeNull();
  });

  it('refuses a position outside the list', () => {
    const existing = [accepted('a', 'CVE-1')];
    expect(removeAcceptedEntry(existing, 0)).toBeNull();
    expect(removeAcceptedEntry(existing, 2)).toBeNull();
  });

  it('writes two-space JSON with a trailing newline that reads back to the same entries', () => {
    const entries = [accepted('libfoo', 'CVE-2024-0001', 'known'), accepted('libbar', 'CVE-2024-0002')];
    const text = serializeAcceptedFile(entries);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "accepted": [');
    expect(parseAcceptedFile(text).entries).toEqual(entries);
  });
});

describe('componentNameOf', () => {
  it('cuts the version off at the last colon', () => {
    expect(componentNameOf('netty-codec:4.1.100')).toBe('netty-codec');
    expect(componentNameOf('org.example:artifact:1.2.3')).toBe('org.example:artifact');
    expect(componentNameOf('standalone')).toBe('standalone');
  });
});

describe('acceptedEntriesOf — what accepting a row writes', () => {
  it('lists one entry per CVE of every member of a merged row, by component name', () => {
    const group = [
      component('a:1.0', 'High', [['CVE-2024-0001', 'High']]),
      component('b:2.0', 'High', [['CVE-2024-0002', 'High'], ['CVE-2024-0003', 'Low']]),
    ];
    expect(acceptedEntriesOf(group)).toEqual([
      { component: 'a', cve: 'CVE-2024-0001' },
      { component: 'b', cve: 'CVE-2024-0002' },
      { component: 'b', cve: 'CVE-2024-0003' },
    ]);
  });

  it('writes a CVE once when two members share a component name and the CVE', () => {
    const group = [
      component('a:1.0', 'High', [['CVE-2024-0001', 'High']]),
      component('a:2.0', 'High', [['CVE-2024-0001', 'High']]),
    ];
    expect(acceptedEntriesOf(group)).toEqual([{ component: 'a', cve: 'CVE-2024-0001' }]);
  });

  it('adds the reason to every entry when one is given', () => {
    const group = [component('a:1.0', 'High', [['CVE-2024-0001', 'High']])];
    expect(acceptedEntriesOf(group, 'not reachable')).toEqual([{ component: 'a', cve: 'CVE-2024-0001', reason: 'not reachable' }]);
  });

  it('is empty for a component with no CVE data', () => {
    expect(acceptedEntriesOf([component('a:1.0', 'High', [])])).toEqual([]);
  });
});

// Accepted components (accepted-components plan, U1): an entry without a CVE accepts one exact
// component name + version.
const acceptedComponent = (component: string, version: string, reason?: string): AcceptedEntry =>
  (reason === undefined ? { component, version } : { component, version, reason });

describe('component entries in the accepted file', () => {
  it('reads a file with only component + CVE entries exactly as before (AE6)', () => {
    const parsed = parseAcceptedFile(JSON.stringify({ accepted: [{ component: 'libfoo', cve: 'CVE-2024-0001', reason: 'x' }] }));
    expect(parsed.entries).toEqual([{ component: 'libfoo', cve: 'CVE-2024-0001', reason: 'x' }]);
    expect(parsed.warning).toBeNull();
  });

  it('reads an entry with a version and no CVE as a component entry', () => {
    const parsed = parseAcceptedFile(JSON.stringify({ accepted: [{ component: 'netty-codec', version: '4.1.100', reason: 'no update' }] }));
    expect(parsed.entries).toEqual([{ component: 'netty-codec', version: '4.1.100', reason: 'no update' }]);
    expect(parsed.warning).toBeNull();
  });

  it('skips an entry with only a component and counts it in the warning', () => {
    const parsed = parseAcceptedFile(JSON.stringify({ accepted: [{ component: 'libfoo' }, { component: 'libbar', version: '1.0' }] }));
    expect(parsed.entries).toEqual([{ component: 'libbar', version: '1.0' }]);
    expect(parsed.warning).toMatch(/1 entry/);
  });

  it('reads an entry with both a CVE and a version as a CVE pair and ignores the version', () => {
    const parsed = parseAcceptedFile(JSON.stringify({ accepted: [{ component: 'libfoo', version: '1.0', cve: 'CVE-2024-0001' }] }));
    expect(parsed.entries).toEqual([{ component: 'libfoo', cve: 'CVE-2024-0001' }]);
  });

  it('round-trips a mixed file through serialize and parse', () => {
    const entries = [accepted('libfoo', 'CVE-2024-0001'), acceptedComponent('netty-codec', '4.1.100', 'no update')];
    expect(parseAcceptedFile(serializeAcceptedFile(entries)).entries).toEqual(entries);
  });
});

describe('matching a component and version', () => {
  it('splits the version off at the last colon', () => {
    expect(componentVersionOf('org.x:lib:1.2.3')).toBe('1.2.3');
    expect(componentVersionOf('no-version')).toBe('');
  });

  it('matches name and version case-insensitively and trimmed', () => {
    const keys = acceptedComponentKeys([acceptedComponent(' Netty-Codec ', '4.1.100-RC1')]);
    expect(isComponentAccepted('netty-codec:4.1.100-rc1', keys)).toBe(true);
  });

  it('does not match another version of the same component (AE4)', () => {
    const keys = acceptedComponentKeys([acceptedComponent('netty-codec', '4.1.100')]);
    expect(isComponentAccepted('netty-codec:4.1.101', keys)).toBe(false);
    expect(isComponentAccepted('netty-codec-http:4.1.100', keys)).toBe(false);
  });

  it('ignores CVE pairs when building the component keys', () => {
    expect(acceptedComponentKeys([accepted('libfoo', 'CVE-2024-0001')]).size).toBe(0);
  });
});

describe('narrowGroup with accepted components', () => {
  it('drops the accepted version and keeps the newer one (AE1, AE4)', () => {
    const entries = [acceptedComponent('netty-codec', '4.1.100')];
    const old = component('netty-codec:4.1.100', 'High', [['CVE-2024-0001', 'High']]);
    const newer = component('netty-codec:4.1.101', 'High', [['CVE-2024-0001', 'High']]);
    const result = narrowGroup([old, newer], entries, 'High');
    expect(result.group!.map(c => c.nameVersion)).toEqual(['netty-codec:4.1.101']);
    expect(result.hiddenComponents).toBe(1);
  });

  it('drops the whole row when its only component is accepted, whatever its CVEs say (AE5)', () => {
    const group = [component('libfoo:1.0', 'Critical', [['CVE-2099-0001', 'Critical']])];
    const result = narrowGroup(group, [acceptedComponent('libfoo', '1.0')], 'High');
    expect(result.group).toBeNull();
    expect(result.hiddenComponents).toBe(1);
    expect(result.hiddenCves).toBe(0);
  });

  it('keeps the other members of a merged group untouched', () => {
    const keep = component('libbar:2.0', 'High', [['CVE-2024-0002', 'High']]);
    const result = narrowGroup([component('libfoo:1.0', 'High', []), keep], [acceptedComponent('libfoo', '1.0')], 'High');
    expect(result.group![0]).toBe(keep);
  });

  it('reports no hidden components when nothing matched', () => {
    const group = [component('libfoo:1.0', 'High', [['CVE-2024-0001', 'High']])];
    const result = narrowGroup(group, [acceptedComponent('other', '1.0')], 'High');
    expect(result.group).toBe(group);
    expect(result.hiddenComponents).toBe(0);
  });
});

describe('writing and removing component entries', () => {
  it('writes one entry per member that has a version, with the reason', () => {
    const group = [component('netty-codec:4.1.100', 'High', []), component('libfoo:1.0', 'High', [])];
    expect(acceptedComponentEntriesOf(group, 'no update')).toEqual([
      { component: 'netty-codec', version: '4.1.100', reason: 'no update' },
      { component: 'libfoo', version: '1.0', reason: 'no update' },
    ]);
  });

  it('does not repeat a component + version already on the list (case-insensitive)', () => {
    const result = addAcceptedEntries([acceptedComponent('libfoo', '1.0')], [acceptedComponent('LIBFOO', '1.0'), acceptedComponent('libfoo', '2.0')]);
    expect(result.added).toBe(1);
    expect(result.entries).toHaveLength(2);
  });

  it('keeps a CVE pair and a component entry for the same component separate', () => {
    const result = addAcceptedEntries([accepted('libfoo', 'CVE-2024-0001')], [acceptedComponent('libfoo', '1.0')]);
    expect(result.added).toBe(1);
  });

  it('removes a component entry by name and version and leaves pairs alone', () => {
    const entries = [accepted('libfoo', 'CVE-2024-0001'), acceptedComponent('libfoo', '1.0')];
    const result = removeAcceptedComponent(entries, 'LibFoo', '1.0');
    expect(result!.entries).toEqual([accepted('libfoo', 'CVE-2024-0001')]);
    expect(removeAcceptedComponent(entries, 'libfoo', '9.9')).toBeNull();
  });

  it('removeAcceptedPair never removes a component entry', () => {
    expect(removeAcceptedPair([acceptedComponent('libfoo', '1.0')], 'libfoo', '1.0')).toBeNull();
  });
});
