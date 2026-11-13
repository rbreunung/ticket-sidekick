import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolDefinition } from '../tools/toolDefinition';

// The `contributes.languageModelTools` entries of the Jira tools, derived from the tool catalog.
// VS Code wants them written out in package.json, so `scripts/sync-jira-tools.mjs` writes what
// this builds and `jiraExtensionTools.test.ts` fails when package.json and the catalog differ.
// Only the build script and the test load this module; the extension bundle does not.

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

/** `jira_view_ticket` → `jiraViewTicket`: the name a user types after `#` to reference the tool. */
export function toolReferenceName(name: string): string {
  return name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function firstSentence(text: string): string {
  const end = text.search(/[.:](\s|$)/);
  return (end === -1 ? text : text.slice(0, end + 1)).replace(/:$/, '.');
}

export function jiraToolManifest(tools: readonly ToolDefinition<never>[]): ToolManifestEntry[] {
  return tools.map(tool => {
    const schema = zodToJsonSchema(z.object(tool.inputSchema), { $refStrategy: 'none', target: 'jsonSchema7' }) as Record<string, unknown>;
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
      tags: ['jira'],
      inputSchema: schema,
    };
  });
}
