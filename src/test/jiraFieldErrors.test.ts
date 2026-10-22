import { describe, it, expect } from 'vitest';
import { refusedFieldsOf } from '../utils/jiraFieldErrors';
import { JiraApiError, BitbucketApiError } from '../utils/apiError';

const jiraError = (status: number, body: unknown) =>
  new JiraApiError(`Jira API error ${status}`, status, 'https://jira.example.com/rest/api/2/issue', typeof body === 'string' ? body : JSON.stringify(body));

describe('refusedFieldsOf', () => {
  it('names the optional field Jira says is not on the screen', () => {
    const err = jiraError(400, { errorMessages: [], errors: { duedate: "Field 'duedate' cannot be set. It is not on the appropriate screen, or unknown." } });
    expect(refusedFieldsOf(err, ['duedate'])).toEqual(['duedate']);
  });

  it('names both fields when two optional fields are refused, and only those asked about', () => {
    const err = jiraError(400, { errors: { duedate: 'no', priority: 'no', summary: 'no' } });
    expect(refusedFieldsOf(err, ['duedate', 'priority'])).toEqual(['duedate', 'priority']);
  });

  it('ignores a 400 that is only about another field', () => {
    expect(refusedFieldsOf(jiraError(400, { errors: { summary: 'Summary is required' } }), ['duedate'])).toEqual([]);
  });

  it('ignores any other status', () => {
    expect(refusedFieldsOf(jiraError(500, { errors: { duedate: 'x' } }), ['duedate'])).toEqual([]);
    expect(refusedFieldsOf(jiraError(403, { errors: { duedate: 'x' } }), ['duedate'])).toEqual([]);
  });

  it('ignores a body that is not JSON, an empty body and a body with no errors object', () => {
    expect(refusedFieldsOf(jiraError(400, '<html>Bad request</html>'), ['duedate'])).toEqual([]);
    expect(refusedFieldsOf(jiraError(400, ''), ['duedate'])).toEqual([]);
    expect(refusedFieldsOf(jiraError(400, { errorMessages: ['duedate is bad'] }), ['duedate'])).toEqual([]);
    expect(refusedFieldsOf(jiraError(400, { errors: 'duedate' }), ['duedate'])).toEqual([]);
  });

  it('ignores errors that are not Jira API errors', () => {
    expect(refusedFieldsOf(new Error('boom'), ['duedate'])).toEqual([]);
    expect(refusedFieldsOf(new BitbucketApiError('x', 400, 'u', JSON.stringify({ errors: { duedate: 'x' } })), ['duedate'])).toEqual([]);
    expect(refusedFieldsOf('duedate', ['duedate'])).toEqual([]);
  });

  it('does not match inherited object keys', () => {
    expect(refusedFieldsOf(jiraError(400, { errors: {} }), ['toString', 'constructor'])).toEqual([]);
  });
});
