import { describe, it, expect, beforeEach } from 'vitest';
import { FieldResolver } from '../templates/FieldResolver';
import { MockJiraClient } from './mocks/MockJiraClient';

describe('FieldResolver', () => {
  let client: MockJiraClient;
  let resolver: FieldResolver;

  beforeEach(() => {
    client = new MockJiraClient();
    resolver = new FieldResolver(client, 'PROJ');
  });

  it('passes defaultFields through unchanged', async () => {
    const result = await resolver.resolve({ priority: 'High', labels: ['billing'] }, {});
    expect(result).toEqual({ priority: 'High', labels: ['billing'] });
  });

  it('resolves sprint id directly without API call', async () => {
    const result = await resolver.resolve({}, { customfield_10020: { type: 'sprint', id: 42 } });
    expect(result.customfield_10020).toEqual({ id: 42 });
  });

  it('resolves sprint by name via API', async () => {
    const result = await resolver.resolve({}, { customfield_10020: { type: 'sprint', name: 'Sprint 5' } });
    expect(result.customfield_10020).toEqual({ id: 42 });
  });

  it('resolves team id directly without API call', async () => {
    const result = await resolver.resolve({}, { customfield_10200: { type: 'team', id: 'abc-team-id' } });
    expect(result.customfield_10200).toEqual({ id: 'abc-team-id' });
  });

  it('resolves team by name via API', async () => {
    const result = await resolver.resolve({}, { customfield_10200: { type: 'team', name: 'Backend Team' } });
    expect(result.customfield_10200).toEqual({ id: 'backend-team-id' });
  });

  it('resolves user by name via findUser', async () => {
    const result = await resolver.resolve({}, { customfield_10300: { type: 'user', name: 'jane' } });
    expect(result.customfield_10300).toEqual({ accountId: 'abc123' });
  });

  it('resolves array of specs into an array of values', async () => {
    const result = await resolver.resolve({}, {
      customfield_10200: [{ type: 'team', id: 'team-1' }, { type: 'team', id: 'team-2' }],
    });
    expect(result.customfield_10200).toEqual([{ id: 'team-1' }, { id: 'team-2' }]);
  });

  it('id takes precedence over name when both provided', async () => {
    const result = await resolver.resolve({}, {
      customfield_10020: { type: 'sprint', id: 99, name: 'Sprint 5' },
    });
    expect(result.customfield_10020).toEqual({ id: 99 });
  });

  it('merges defaultFields and resolveFields in result', async () => {
    const result = await resolver.resolve(
      { priority: 'High' },
      { customfield_10020: { type: 'sprint', id: 42 } },
    );
    expect(result.priority).toBe('High');
    expect(result.customfield_10020).toEqual({ id: 42 });
  });

  it('throws for unknown resolve type', async () => {
    await expect(
      resolver.resolve({}, { customfield_10999: { type: 'unknown' as 'sprint', name: 'x' } }),
    ).rejects.toThrow('Unknown resolve type');
  });

  it('throws when user not found', async () => {
    await expect(
      resolver.resolve({}, { customfield_10300: { type: 'user', name: 'nobody' } }),
    ).rejects.toThrow('No user found');
  });
});
