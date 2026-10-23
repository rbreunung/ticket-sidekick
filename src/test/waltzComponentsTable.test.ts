import { describe, it, expect } from 'vitest';
import { readWaltzComponents } from '../utils/waltzComponentsTable';
import {
  buildDescriptionWiki, buildGroupDescriptionWiki, buildGroupLabels, buildGroupSummary,
  type WaltzComponent,
} from '../utils/waltzReport';

function comp(nameVersion: string, over: Partial<WaltzComponent> = {}): WaltzComponent {
  return {
    nameVersion,
    maxVulnRating: 'High',
    remediationAction: 'Remediate',
    instancePaths: ['/app/a.jar'],
    vulnerabilities: [{ cveId: 'CVE-2099-0001', cveSummary: null, overallSeverity: 'High', cvssV3Score: 7, fixedVersion: null }],
    remediation: { policyDate: '2026-11-30', plannedDate: '2026-12-15', attestationDate: null, planStatus: 'Overdue', reportDate: '2026-10-22' },
    ...over,
  };
}

function ticketOf(group: WaltzComponent[]) {
  return { wiki: buildGroupDescriptionWiki(group), summary: buildGroupSummary(group), labels: buildGroupLabels(group) };
}

describe('readWaltzComponents', () => {
  it('reads a single-component ticket back from its one-row table', () => {
    const { wiki, summary, labels } = ticketOf([comp('example-lib:1.2.3')]);

    const result = readWaltzComponents(wiki, { summary, labels });

    expect(result.detailSource).toBe('table');
    expect(result.edited).toBe(false);
    expect(result.components).toEqual([expect.objectContaining({
      nameVersion: 'example-lib:1.2.3', rating: 'High', remediationAction: 'Remediate', cveCount: 1, artifactCount: 1,
      policyDate: '2026-11-30', plannedDate: '2026-12-15', attestationDate: null, planStatus: 'Overdue', detailSource: 'table',
    })]);
  });

  it('reads a merged ticket with 7 components back to 7 records', () => {
    const names = ['netty-codec', 'netty-handler', 'netty-buffer', 'netty-common', 'netty-transport', 'netty-resolver', 'netty-codec-http'];
    const group = names.map((n, i) => comp(`${n}:4.1.100`, { remediation: { policyDate: `2026-11-0${i + 1}`, plannedDate: null, attestationDate: null, planStatus: null, reportDate: null } }));
    const { wiki, summary, labels } = ticketOf(group);

    const result = readWaltzComponents(wiki, { summary, labels });

    expect(result.components.map(c => c.nameVersion)).toEqual(names.map(n => `${n}:4.1.100`));
    expect(result.components[3].policyDate).toBe('2026-11-04');
    expect(result.edited).toBe(false);
  });

  it('reads an undated component as empty dates and a missing action as null', () => {
    const { wiki, summary, labels } = ticketOf([comp('example-lib:1.2.3', { remediationAction: null, remediation: undefined })]);

    const [c] = readWaltzComponents(wiki, { summary, labels }).components;

    expect(c).toMatchObject({ policyDate: null, plannedDate: null, attestationDate: null, planStatus: null, remediationAction: null });
  });

  it('reads the previous folded table, which has no action column, as legacy', () => {
    const old = [
      '||Component||Max rating||CVEs||Artifacts||Policy date||Planned date||Attestation date||Plan status||',
      '|example-a:1.0.0|High|2|1|n/a|2026-12-15|n/a|Overdue|',
    ].join('\n');

    const result = readWaltzComponents(old, { summary: null, labels: [] });

    expect(result.detailSource).toBe('legacy');
    expect(result.components[0]).toMatchObject({ nameVersion: 'example-a:1.0.0', rating: 'High', cveCount: 2, plannedDate: '2026-12-15', remediationAction: null });
  });

  it('reads the older single-component ticket whose dates sit in a Remediation dates section, with name and rating from the title', () => {
    const legacy = 'h3. Max Vuln Rating\nHigh\n\nh3. Remediation dates\n||Policy date||Planned date||Attestation date||Plan status||\n|2026-11-30|2026-12-15|n/a|n/a|';

    const result = readWaltzComponents(legacy, { summary: '[OSS] example-lib:1.2.3 — High', labels: ['oss-dependency'] });

    expect(result.detailSource).toBe('legacy');
    expect(result.components).toEqual([expect.objectContaining({ nameVersion: 'example-lib:1.2.3', rating: 'High', policyDate: '2026-11-30', plannedDate: '2026-12-15' })]);
  });

  it('falls back to the title and rating label when the description holds nothing readable', () => {
    const result = readWaltzComponents('Edited by hand.', { summary: '[OSS] netty-codec:4.1.100 +6 components — Critical', labels: ['oss-dependency', 'oss-rating-critical'] });

    expect(result.detailSource).toBe('title-labels');
    expect(result.components).toEqual([expect.objectContaining({ nameVersion: 'netty-codec:4.1.100', rating: 'Critical', policyDate: null })]);
  });

  it('takes the rating from the label when the title no longer ends in one', () => {
    const [c] = readWaltzComponents(null, { summary: 'Renamed ticket', labels: ['oss-rating-high'] }).components;
    expect(c).toMatchObject({ nameVersion: null, rating: 'high' });
  });

  it('reports a ticket with fewer component labels than listed components as edited', () => {
    const { wiki, summary, labels } = ticketOf([comp('example-a:1.0.0'), comp('example-b:2.0.0')]);
    const withoutOne = labels.filter(l => !l.startsWith('oss-dep-example-b'));

    const result = readWaltzComponents(wiki, { summary, labels: withoutOne });

    expect(result.edited).toBe(true);
    expect(result.components).toHaveLength(2);
  });

  it('reads a cell holding text instead of a date as no date for that date only', () => {
    const wiki = '||Component||Max rating||Remediation action||CVEs||Artifacts||Policy date||Planned date||Attestation date||Plan status||\n|a:1|High|n/a|1|1|soon|2026-12-15|n/a|n/a|';
    const [c] = readWaltzComponents(wiki, { summary: null, labels: [] }).components;
    expect(c).toMatchObject({ policyDate: null, plannedDate: '2026-12-15' });
  });

  it('returns nothing, not an error, for text that is not a Waltz ticket', () => {
    expect(readWaltzComponents(undefined, { summary: 'Fix login', labels: ['bug'] }).components).toEqual([]);
  });

  it('keeps single-component descriptions readable through the same entry point as folded ones', () => {
    const c = comp('example-lib:1.2.3');
    expect(readWaltzComponents(buildDescriptionWiki(c), { summary: null, labels: [] }).components[0].nameVersion).toBe('example-lib:1.2.3');
  });
});
