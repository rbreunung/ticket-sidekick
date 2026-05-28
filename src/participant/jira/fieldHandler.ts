import * as vscode from 'vscode';
import { TicketService, resolveFieldIdFuzzy, extractTextFromAdf } from '../../services/TicketService';
import type { JiraFieldMeta } from '../../jira/IJiraClient';
import type { FieldUpdatePreviewSession, FieldSelectionSession, SprintSelectionSession, ContentSession } from '../sessionState';
import { isCancellation } from '../sessionState';
import { spellCheckValue } from './llmHelpers';
import { streamContentPreview } from './contentHandler';
import { wikiToMarkdown } from '../../utils/markdownFormatter';

export async function streamFieldUpdatePreview(
  session: FieldUpdatePreviewSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<void> {
  await ws.update('jira.session.fieldUpdatePreview', session);
  const scope = session.ticketKeys.length === 1
    ? session.ticketKeys[0]
    : `${session.ticketKeys.length} tickets`;
  const displayValue = typeof session.fieldValue === 'string'
    ? session.fieldValue
    : JSON.stringify(session.fieldValue);
  stream.markdown(
    `**Preview: set ${session.fieldName}**\n\n` +
    `Setting **${session.fieldName}** (\`${session.fieldId}\`) to \`${displayValue}\` on ${scope}.\n\n` +
    `Reply **ok** to apply, or **(c)** to cancel.\n\n<!-- jira:field-update-preview -->`,
  );
}

export async function continueSetField(
  ticketKeys: string[],
  field: JiraFieldMeta,
  fieldValueRaw: string,
  arrayOp: 'set' | 'add' | 'remove',
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<void> {
  const sampleKey = ticketKeys[0];
  const isSprintField = Boolean(field.schema.custom?.includes('gh-sprint'));
  const isArray = field.schema.type === 'array';

  if (isSprintField) {
    const projectKey = sampleKey.split('-')[0];
    let candidates: import('../../jira/IJiraClient').JiraSprintCandidate[];
    try {
      candidates = await ticketService.findSprints(projectKey, fieldValueRaw);
    } catch (err) {
      stream.markdown(`Could not search sprints: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (candidates.length === 0) {
      stream.markdown(`No active or future sprint matching "${fieldValueRaw}" in project ${projectKey}.`);
      return;
    }
    if (candidates.length === 1) {
      await streamFieldUpdatePreview({
        ticketKeys, fieldId: field.id, fieldName: field.name,
        fieldValue: candidates[0].id, isArray: true, arrayOp: 'set',
      }, stream, ws);
      return;
    }
    const previewPlaceholder: FieldUpdatePreviewSession = {
      ticketKeys, fieldId: field.id, fieldName: field.name,
      fieldValue: null, isArray: true, arrayOp: 'set',
    };
    const sprintSession: SprintSelectionSession = {
      candidates,
      pending: { kind: 'field-update', session: previewPlaceholder },
    };
    await ws.update('jira.session.sprintSelection', sprintSession);
    const list = candidates.map((s, i) => `${i + 1}. ${s.name} (${s.state})`).join('\n');
    stream.markdown(`Multiple sprints match "${fieldValueRaw}":\n\n${list}\n\nWhich one? Reply with a number, or **(c)** to cancel.\n\n<!-- jira:sprint-selection -->`);
    return;
  }

  let fieldValue: unknown;
  try {
    if (isArray) {
      const rawValues = fieldValueRaw.split(',').map(v => v.trim()).filter(Boolean);
      let currentValue: unknown = null;
      if (arrayOp !== 'set') {
        currentValue = await ticketService.getRawField(sampleKey, field.id);
      }
      fieldValue = await ticketService.buildArrayValue(field.id, sampleKey, rawValues, arrayOp, currentValue);
    } else {
      fieldValue = await ticketService.buildFieldValue(field.id, sampleKey, fieldValueRaw);
    }
  } catch (err) {
    stream.markdown(`Could not build field value: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  await streamFieldUpdatePreview({
    ticketKeys, fieldId: field.id, fieldName: field.name,
    fieldValue, isArray, arrayOp,
  }, stream, ws);
}

export async function handleSetField(
  ticketKeys: string[],
  fieldNameRaw: string,
  fieldValueRaw: string,
  arrayOp: 'set' | 'add' | 'remove',
  fieldMeta: JiraFieldMeta[],
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<void> {
  const navigable = fieldMeta.filter(f => f.navigable === true);
  const resolution = resolveFieldIdFuzzy(fieldNameRaw, navigable);

  if (resolution.kind === 'none') {
    stream.markdown(`No field matching "${fieldNameRaw}" found. Use \`@jira show fields on ${ticketKeys[0]}\` to see available fields.`);
    return;
  }

  if (resolution.kind === 'candidates') {
    const selSession: FieldSelectionSession = {
      candidates: resolution.fields,
      pending: { fieldValue: fieldValueRaw, arrayOp, ticketKeys },
    };
    await ws.update('jira.session.fieldSelection', selSession);
    const list = resolution.fields.map((f, i) => `${i + 1}. ${f.name} (\`${f.id}\`)`).join('\n');
    stream.markdown(`Multiple fields match "${fieldNameRaw}":\n\n${list}\n\nWhich one? Reply with a number, or **(c)** to cancel.\n\n<!-- jira:selecting-field -->`);
    return;
  }

  await continueSetField(
    ticketKeys, resolution.field, fieldValueRaw, arrayOp,
    ticketService, stream, ws, model, token,
  );
}

export async function handleSpellCheck(
  ticketKey: string,
  ticketService: TicketService,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  ws: vscode.Memento,
): Promise<void> {
  const issue = await ticketService.getIssue(ticketKey);
  const rawDescription = extractTextFromAdf(issue.fields.description);
  if (!rawDescription.trim()) {
    stream.markdown(`**${ticketKey}** has no description to check.`);
    return;
  }
  const markdownDescription = wikiToMarkdown(rawDescription);
  const corrected = await spellCheckValue(markdownDescription, model, token);
  if (!corrected) {
    stream.markdown(`No spelling or grammar issues found in **${ticketKey}**.`);
    return;
  }
  const session: ContentSession = {
    ticketKey,
    operation: 'updateDescription',
    currentContent: corrected,
    historyContext: undefined,
    contentSource: 'generate',
  };
  await streamContentPreview(session, stream, ws);
  stream.markdown(`\n\n<!-- @jira-ticket:${ticketKey} -->`);
}
