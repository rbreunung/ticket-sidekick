import { describe, it, expect } from 'vitest';
import { renderReviewTable, buildJiraNotConfiguredMessage, type ReviewTableColumn } from '../participant/sessionState';

interface Widget {
  name: string;
  qty: number;
}

const WIDGET_COLUMNS: ReviewTableColumn<Widget>[] = [
  { header: 'Name', accessor: (w) => w.name },
  { header: 'Qty', accessor: (w) => String(w.qty) },
];

describe('renderReviewTable', () => {
  it('renders a header row, a separator row, and one data row per input row', () => {
    const rows: Widget[] = [
      { name: 'Bolt', qty: 3 },
      { name: 'Nut', qty: 7 },
    ];

    const result = renderReviewTable(WIDGET_COLUMNS, rows);
    const lines = result.split('\n');

    expect(lines).toEqual([
      '| Name | Qty |',
      '| --- | --- |',
      '| Bolt | 3 |',
      '| Nut | 7 |',
    ]);
  });

  it('renders header and separator only when given zero rows', () => {
    const result = renderReviewTable(WIDGET_COLUMNS, []);
    const lines = result.split('\n');

    expect(lines).toEqual([
      '| Name | Qty |',
      '| --- | --- |',
    ]);
  });

  it('follows the dash-per-column separator style (KTD4)', () => {
    const threeColumns: ReviewTableColumn<Widget>[] = [
      { header: 'Name', accessor: (w) => w.name },
      { header: 'Qty', accessor: (w) => String(w.qty) },
      { header: 'Extra', accessor: () => '' },
    ];
    const result = renderReviewTable(threeColumns, []);
    const separatorLine = result.split('\n')[1];

    expect(separatorLine).toBe('| --- | --- | --- |');
  });

  it('does not escape or strip a literal pipe or newline in cell content', () => {
    const columns: ReviewTableColumn<Widget>[] = [
      { header: 'Name', accessor: (w) => w.name },
    ];
    const rows: Widget[] = [{ name: 'a | b\nc', qty: 1 }];

    const result = renderReviewTable(columns, rows);

    expect(result).toContain('a | b\nc');
  });

  it('holds no state between calls with different column arrays', () => {
    const first = renderReviewTable(WIDGET_COLUMNS, [{ name: 'Bolt', qty: 3 }]);

    interface Other {
      label: string;
    }
    const otherColumns: ReviewTableColumn<Other>[] = [
      { header: 'Label', accessor: (o) => o.label },
    ];
    const second = renderReviewTable(otherColumns, [{ label: 'x' }]);

    expect(first).toBe('| Name | Qty |\n| --- | --- |\n| Bolt | 3 |');
    expect(second).toBe('| Label |\n| --- |\n| x |');

    // Calling again with the original columns still produces the original output — no
    // leftover state from the intervening call with a different column array.
    const firstAgain = renderReviewTable(WIDGET_COLUMNS, [{ name: 'Bolt', qty: 3 }]);
    expect(firstAgain).toBe(first);
  });
});

describe('buildJiraNotConfiguredMessage', () => {
  it('names the base URL setting when baseUrl is missing', () => {
    const message = buildJiraNotConfiguredMessage({ baseUrl: undefined, token: undefined, authType: 'datacenter' });

    expect(message).toContain('ticketSidekick.jira.baseUrl');
  });

  it('names the Data Center PAT setup command when only the token is missing', () => {
    const message = buildJiraNotConfiguredMessage({ baseUrl: 'https://jira.example.com', token: undefined, authType: 'datacenter' });

    expect(message).toContain('Ticket Sidekick: Set Jira Personal Access Token');
  });

  it('names the Cloud credentials setup command when only the token is missing (Cloud)', () => {
    const message = buildJiraNotConfiguredMessage({ baseUrl: 'https://example.atlassian.net', token: undefined, authType: 'cloud' });

    expect(message).toContain('Ticket Sidekick: Configure Jira Cloud Credentials');
  });

  it('never emits a trusted MarkdownString command link — plain text only', () => {
    const message = buildJiraNotConfiguredMessage({ baseUrl: undefined, token: undefined, authType: 'cloud' });

    expect(message).not.toContain('(command:');
  });
});
