import { z } from 'zod';
import type { ToolDefinition } from '../tools/toolDefinition';

// The `contributes.languageModelTools` entries of the Jira and Bitbucket tools, derived from the
// tool catalogs, one tag per catalog. VS Code wants them written out in package.json, so
// `scripts/sync-tools.mjs` writes what this builds and `toolManifest.test.ts` fails when
// package.json and the catalogs differ. Only the build script and the test load this module; the
// extension bundle does not.

export interface ToolManifestEntry {
  name: string;
  displayName: string;
  modelDescription: string;
  userDescription: string;
  canBeReferencedInPrompt: boolean;
  toolReferenceName: string;
  icon: string;
  tags: string[];
  inputSchema: Record<string, unknown>;
}

/** `jira_view_ticket` → `jiraViewTicket`, `bitbucket_getPullRequest` → `bitbucketGetPullRequest`: the name a user types after `#` to reference the tool. */
export function toolReferenceName(name: string): string {
  return name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function firstSentence(text: string): string {
  const end = text.search(/[.:](\s|$)/);
  return (end === -1 ? text : text.slice(0, end + 1)).replace(/:$/, '.');
}

/** The manifest entries of one catalog's tools, each tagged with the catalog's product, e.g. `jira`. */
export function toolManifest(tools: readonly ToolDefinition<never>[], tag: string): ToolManifestEntry[] {
  return tools.map(tool => {
    const schema = z.toJSONSchema(z.object(tool.inputSchema), { target: 'draft-7', reused: 'inline' }) as Record<string, unknown>;
    delete schema.$schema;
    delete schema.additionalProperties;
    return {
      name: tool.name,
      displayName: tool.title,
      modelDescription: tool.description,
      userDescription: firstSentence(tool.description),
      canBeReferencedInPrompt: true,
      toolReferenceName: toolReferenceName(tool.name),
      icon: tool.annotations.readOnlyHint ? '$(search)' : '$(edit)',
      tags: [tag],
      inputSchema: schema,
    };
  });
}
