import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gatherOverview, overviewWarningText } from '../utils/securityOverviewGather';
import { buildOverview } from '../utils/securityOverview';
import { TicketService } from '../services/TicketService';
import { MockJiraClient } from './mocks/MockJiraClient';
import { descriptionsOf, makeComponent, makeFlaw, seedOverviewJira, veracodeTicket, waltzTicket } from './helpers/overviewFixtures';
import { JiraApiError } from '../utils/apiError';

// The one Jira reading behind both `@jira /security-report` and the security report canvas.

let client: MockJiraClient;
let service: TicketService;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-15T12:00:00Z') });
  client = new MockJiraClient();
  service = new TicketService(client);
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const tickets = [
  veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'], dueDate: '2026-11-01' }),
  waltzTicket('SEC-2', [makeComponent('netty-codec:4.1.100')], { fixVersions: ['2026.11'] }),
];

describe('gathering the security overview from Jira', () => {
  it('reads the project\'s tickets, release dates and descriptions, with no warnings', async () => {
    seedOverviewJira(client, tickets);
    const result = await gatherOverview(service, 'SEC', 'https://jira.example.com');
    if (!result.ok) throw new Error('expected a reading');
    expect(result.warnings).toEqual([]);
    expect(result.input.tickets.map(t => t.key)).toEqual(['SEC-1', 'SEC-2']);
    expect(result.input.descriptions).toEqual(descriptionsOf(tickets));
    expect(result.input.versions).toEqual([expect.objectContaining({ name: '2026.11', releaseDate: '2026-11-15' })]);
    expect(result.input).toMatchObject({ today: '2026-10-15', baseUrl: 'https://jira.example.com', projectKey: 'SEC' });
    expect(buildOverview(result.input).ticketCount).toBe(2);
  });

  it('warns that the list was cut when more tickets matched than can be listed', async () => {
    seedOverviewJira(client, tickets);
    vi.spyOn(service, 'listOverviewTickets').mockResolvedValue({ tickets: tickets.map(t => t.ticket), truncated: true });
    const result = await gatherOverview(service, 'SEC');
    expect(result.ok && result.warnings).toEqual([{ kind: 'truncated', shown: 2 }]);
    expect(overviewWarningText({ kind: 'truncated', shown: 2 })).toBe('More tickets matched than can be listed; showing the first 2.');
  });

  it('warns and uses no release dates when the project versions cannot be read', async () => {
    seedOverviewJira(client, tickets);
    vi.spyOn(client, 'getProject').mockRejectedValue(new Error('boom'));
    const result = await gatherOverview(service, 'SEC');
    if (!result.ok) throw new Error('expected a reading');
    expect(result.warnings).toEqual([{ kind: 'release-dates-unread' }]);
    expect(result.input.versions).toEqual([]);
  });

  it('answers a failed search with the error Jira\'s client threw, and logs it', async () => {
    const error = new JiraApiError('Jira API error 503: <html>proxy page</html>', 503, 'https://jira.example.com/rest/api/2/search', '<html>proxy page</html>');
    vi.spyOn(client, 'searchJql').mockRejectedValue(error);
    const logs: string[] = [];
    const result = await gatherOverview(service, 'SEC', undefined, (_level, message) => logs.push(message));
    expect(result).toEqual({ ok: false, error });
    expect(logs).toEqual(['Overview search failed']);
  });
});
