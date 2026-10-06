import { describe, it, expect } from 'vitest';
import { buildAcceptedHiddenLine, buildAllHiddenMessage } from '../participant/sessionState';

describe('buildAcceptedHiddenLine — what the review says it kept off the New screen (R7)', () => {
  it('says nothing when nothing was hidden', () => {
    expect(buildAcceptedHiddenLine(undefined)).toBe('');
    expect(buildAcceptedHiddenLine({ cves: 0, belowFloor: 0 })).toBe('');
  });

  it('reports accepted CVEs with a link to list them', () => {
    const line = buildAcceptedHiddenLine({ cves: 3, belowFloor: 0 });
    expect(line).toContain('3 accepted CVEs hidden');
    expect(line).not.toContain('rating floor');
    expect(line).toContain('accepted');
    expect(line).toMatch(/command:workbench\.action\.chat\.open/);
  });

  it('reports components below the rating floor apart from accepted CVEs (R10)', () => {
    const line = buildAcceptedHiddenLine({ cves: 1, belowFloor: 2 });
    expect(line).toContain('1 accepted CVE hidden');
    expect(line).toContain('2 components below the rating floor');
  });

  it('reports a below-floor component even when only that was hidden', () => {
    const line = buildAcceptedHiddenLine({ cves: 0, belowFloor: 1 });
    expect(line).toContain('1 component below the rating floor');
    expect(line).not.toContain('accepted CVE');
  });
});

describe('buildAllHiddenMessage — nothing left after the list is applied', () => {
  it('names what was hidden instead of the filter-mismatch message', () => {
    const message = buildAllHiddenMessage({ cves: 4, belowFloor: 1 });
    expect(message).toContain('4 accepted CVEs');
    expect(message).toContain('1 component below the rating floor');
    expect(message).toContain('.jira-oss-accepted.json');
    expect(message).not.toMatch(/no components .* matched your/i);
  });
});
