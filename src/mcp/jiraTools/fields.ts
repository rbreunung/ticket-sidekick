import { z } from 'zod';
import { normalizeProjectKey } from '../../services/configValidation';
import { defineTool } from '../mcpServer';
import type { JiraToolDeps } from './jiraAccess';
import { runJiraTool } from './runJiraTool';
import { ticketKeyProblem } from './ticketKeyInput';
import { CHECK_REQUIRED_FIELDS_TOOL, LIST_FIELDS_TOOL, UPDATE_FIELD_TOOL } from './toolNames';

// Two read tools about fields: which fields a ticket or an issue type has, with their ids (the
// ids are what the display settings and templates take), and whether a ticket has the fields the
// user's own settings require.

const listFieldsShape = {
  ticketKey: z.string().optional().describe('A ticket key, e.g. PROJ-123: lists every field of that ticket with its current value.'),
  projectKey: z.string().optional().describe('Without a ticket: the project key, e.g. PROJ.'),
  issueType: z.string().optional().describe('Without a ticket: the issue type, e.g. Bug. Lists the fields that type can take on create.'),
};

export const listFieldsTool = defineTool<JiraToolDeps, typeof listFieldsShape>({
  name: LIST_FIELDS_TOOL,
  title: 'List the fields of a Jira ticket or issue type',
  description:
    'With ticketKey: lists every field of that ticket with its name, id and current value, custom fields included. '
    + 'With projectKey and issueType instead: lists the fields that issue type can take when a ticket is created, with name, id and whether Jira requires each. '
    + `Use it to find a field's name or id for ${UPDATE_FIELD_TOOL}, a template or the display settings. Changes nothing.`,
  inputSchema: listFieldsShape,
  annotations: { readOnlyHint: true },
  handler: async (args, deps) => {
    const key = args.ticketKey?.trim();
    if (key) {
      const problem = ticketKeyProblem(key);
      if (problem) return problem;
      return runJiraTool(deps, LIST_FIELDS_TOOL, `Could not list the fields of ${key}`, ({ ticketService }) => ticketService.showFields(key));
    }
    const project = normalizeProjectKey(args.projectKey ?? '');
    const issueType = args.issueType?.trim();
    if (!project || !issueType) return 'Give a ticketKey, or a projectKey together with an issueType.';
    return runJiraTool(deps, LIST_FIELDS_TOOL, `Could not list the fields of ${issueType} in ${project}`, ({ ticketService }) => ticketService.listCreateFields(project, issueType));
  },
});

const checkRequiredShape = {
  ticketKey: z.string().describe('The ticket key, e.g. PROJ-123.'),
};

export const checkRequiredFieldsTool = defineTool<JiraToolDeps, typeof checkRequiredShape>({
  name: CHECK_REQUIRED_FIELDS_TOOL,
  title: 'Check a Jira ticket for the required fields',
  description:
    'Checks whether a ticket has a value in every field listed in the ticketSidekick.jira.requiredFields setting and names the empty ones. '
    + 'These are the fields the user\'s team requires, not the ones Jira enforces. Changes nothing.',
  inputSchema: checkRequiredShape,
  annotations: { readOnlyHint: true },
  handler: async (args, deps) => {
    const key = args.ticketKey.trim();
    const problem = ticketKeyProblem(key);
    if (problem) return problem;
    return runJiraTool(deps, CHECK_REQUIRED_FIELDS_TOOL, `Could not check ${key}`, ({ config, ticketService }) => ticketService.validateRequiredFields(key, config.requiredFields ?? []));
  },
});
