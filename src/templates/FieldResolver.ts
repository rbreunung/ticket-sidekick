import type { IJiraClient } from '../jira/IJiraClient';
import type { ResolveSpec } from './TemplateService';

export class FieldResolver {
  constructor(
    private readonly client: IJiraClient,
    private readonly projectKey: string,
  ) {}

  async resolve(
    defaultFields: Record<string, unknown>,
    resolveFields: Record<string, ResolveSpec | ResolveSpec[]>,
  ): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = { ...defaultFields };
    for (const [fieldId, spec] of Object.entries(resolveFields)) {
      if (Array.isArray(spec)) {
        result[fieldId] = await Promise.all(spec.map((s) => this.resolveOne(s)));
      } else {
        result[fieldId] = await this.resolveOne(spec);
      }
    }
    return result;
  }

  private async resolveOne(spec: ResolveSpec): Promise<unknown> {
    if (spec.id !== undefined) return { id: spec.id };
    if (!spec.name) throw new Error(`ResolveSpec must have either 'name' or 'id'`);
    switch (spec.type) {
      case 'sprint':
        return this.client.getSprintByName(this.projectKey, spec.name);
      case 'team':
        return this.client.getTeamByName(spec.name);
      case 'user': {
        const users = await this.client.findUser(spec.name);
        if (users.length === 0) throw new Error(`No user found matching "${spec.name}"`);
        return { accountId: users[0].accountId };
      }
      default:
        throw new Error(`Unknown resolve type: ${String((spec as ResolveSpec).type)}`);
    }
  }
}
