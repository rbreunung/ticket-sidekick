import { markdownToJiraWiki } from '../../utils/markdownToJiraWiki';

/**
 * An update-field value as Jira should receive it. Agents write free text as Markdown, so the
 * description, the one free-text field update field supports, is converted to Jira wiki markup
 * with the converter the `@jira` chat flows use; every other field (summary, priority,
 * labels, …) takes its value as written.
 */
export function fieldValueToJira(fieldName: string, value: string): string {
  return fieldName.trim().toLowerCase() === 'description' ? markdownToJiraWiki(value) : value;
}
