import { describe, it, expect } from 'vitest';
import { overviewColumnsReader } from '../boards/overviewColumns';
import type { JiraAccess } from '../tools/jiraTools/jiraAccess';

const FIELDS = [{ id: 'customfield_1', name: 'Squad', schema: { type: 'string' } }];

function access(securityReportFields: string[] | undefined, getFields: () => Promise<unknown>): () => Promise<JiraAccess> {
  return async () => ({
    configured: true,
    config: { baseUrl: 'https://jira.example.com', token: 't', authType: 'datacenter', securityReportFields } as never,
    client: { getFields } as never,
  });
}

describe('the extra columns of the security overview', () => {
  it('resolves the configured ids against Jira\'s field names and never lists assignee twice', async () => {
    const read = overviewColumnsReader(access(['customfield_1', 'assignee'], async () => FIELDS));
    expect((await read()).map(c => [c.id, c.name])).toEqual([['customfield_1', 'Squad']]);
  });

  it('asks Jira for no field names when the setting is empty or missing', async () => {
    let asked = 0;
    const getFields = async () => { asked++; return FIELDS; };
    expect(await overviewColumnsReader(access([], getFields))()).toEqual([]);
    expect(await overviewColumnsReader(access(undefined, getFields))()).toEqual([]);
    expect(asked).toBe(0);
  });

  it('gives no columns when Jira is not set up, and none when the field names cannot be read', async () => {
    expect(await overviewColumnsReader(async () => ({ configured: false, config: {} as never }))()).toEqual([]);
    const logs: string[] = [];
    const read = overviewColumnsReader(access(['customfield_1'], async () => { throw new Error('403'); }), (level, message) => { logs.push(`${level}: ${message}`); });
    expect(await read()).toEqual([]);
    expect(logs).toHaveLength(1);
  });
});
