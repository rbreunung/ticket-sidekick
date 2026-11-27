import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

// Guard for the import board parity ledger in docs/architecture/migration-status.md. Every reply command of the
// import review screens and every optional importer capability must have a row there saying whether the import board
// carries it over or drops it, and every Veracode or Waltz row that carries over must name, in BOARD_PARITY below, the
// board action or rule that keeps it and the scenario test that proves the same result. The same holds for the email
// rows since the email import moved to the board.
// This guard outlives the chat imports: their reply commands are kept below as they were, and this map holds them.
// See docs/solutions/workflow-issues/import-board-parity-list-misses-recent-functional-import-work.md.

const root = process.cwd();
const read = (file: string): string => readFileSync(resolve(root, file), 'utf-8');

/** The text of the ledger section, from its heading up to the next heading of the same or a higher level. */
function ledgerSection(): string {
  const doc = read('docs/architecture/migration-status.md');
  const start = doc.indexOf('#### Import board parity ledger');
  expect(start, 'migration-status.md has an "Import board parity ledger" section').toBeGreaterThanOrEqual(0);
  const rest = doc.slice(doc.indexOf('\n', start) + 1);
  const end = rest.search(/^#{2,4} /m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The table rows of the section, as cells (first cell, decision). */
function tableRows(section: string): Array<{ first: string; decision: string }> {
  const out: Array<{ first: string; decision: string }> = [];
  for (const line of section.split('\n')) {
    const cells = line.split('|').map(c => c.trim());
    if (cells.length < 4 || cells[1].startsWith('---') || cells[2] === 'Board') continue;
    out.push({ first: cells[1], decision: cells[2] });
  }
  return out;
}

const RULES_HEADING = '**Rules with no command or capability of their own**';

/**
 * The ledger rows by name: each code span in the first cell of a command or capability row, and the whole first cell
 * of a rule row (a rule has no catalog id of its own).
 */
function ledgerRows(section: string): Map<string, string> {
  const rows = new Map<string, string>();
  const at = section.indexOf(RULES_HEADING);
  expect(at, `the ledger has a "${RULES_HEADING}" table`).toBeGreaterThanOrEqual(0);
  for (const row of tableRows(section.slice(0, at))) {
    for (const m of row.first.matchAll(/`([^`]+)`/g)) rows.set(m[1], row.decision);
  }
  for (const row of tableRows(section.slice(at))) rows.set(row.first, row.decision);
  return rows;
}

/** The optional members declared directly on an exported interface (two-space indentation; nested members are skipped). */
function optionalMembers(source: string, iface: string): string[] {
  const start = source.indexOf(`export interface ${iface}`);
  expect(start, `${iface} is declared`).toBeGreaterThanOrEqual(0);
  const body = source.slice(start, source.indexOf('\n}', start));
  return [...body.matchAll(/^ {2}(\w+)\?(?::|\()/gm)].map(m => m[1]);
}

const DECISIONS = ['Carry over', 'Dropped'];

/** The reply commands of the chat's import review screens and email cleanup, as their catalog named them before `@jira` was removed. */
const CHAT_COMMANDS = [
  'toggle-rows', 'bulk', 'create', 'fold', 'accept-cve', 'accept-component', 'accepted-list', 'row-action', 'all-action', 'run',
  'merge-tickets', 'toggle-stale', 'close', 'search', 'show', 'export', 'reload', 'paging', 'open', 'exit', 'help',
  'email-strip', 'email-keep', 'email-model-check', 'email-rows', 'email-save', 'email-cancel',
];

interface BoardEquivalent {
  /** The import board actions that keep the behaviour (the `type` of a reduce or plan request). */
  actions?: string[];
  /** The export formats the board saves for it. */
  exports?: string[];
  /** A rule with no action of its own, in words. */
  rule?: string;
  /** The scenario tests that check the same result as the chat flow: file under src/test/, then the test title. */
  tests: Array<[file: string, title: string]>;
}

const NEW = 'importBoardNew.test.ts';
const TICKETED = 'importBoardTicketed.test.ts';
const STALE = 'importBoardStale.test.ts';
const ACCEPTED = 'importBoardAccepted.test.ts';
const MERGE = 'importBoardMerge.test.ts';
const EXPORT = 'importBoardExport.test.ts';
const BOARD = 'importBoard.test.ts';
const START = 'importStartScreen.test.ts';
const EMAIL = 'importBoardEmail.test.ts';
const CLEANUP = 'importBoardEmailCleanup.test.ts';
const MESSAGES = 'boardMessages.test.ts';

const SELECT_ROWS: BoardEquivalent = {
  actions: ['new-include'],
  tests: [[NEW, 'leaves one row or all rows out of the create and takes them back in']],
};
const FOLD: BoardEquivalent = {
  actions: ['new-merge', 'new-unmerge', 'new-add'],
  tests: [
    [NEW, 'creates one ticket for two merged rows, with the folded title and description'],
    [NEW, 'puts the rows of an unmerged merge back as their own tickets'],
    [NEW, 'as a comment: adds the record labels and posts the folded comment'],
    [NEW, 'as a rewrite: rebuilds the ticket from its findings and the added row, with the SLA Due Date'],
  ],
};
const ACCEPT: BoardEquivalent = {
  actions: ['accept-cve', 'accept-component', 'unaccept', 'unaccept-component'],
  tests: [
    [ACCEPTED, 'previews the one entry it adds, and after Apply the row has left New and the Accepted tab lists the entry'],
    [ACCEPTED, 'drops the component from New and Already ticketed, and its ticket moves onto Stale'],
    [ACCEPTED, 'removes a component entry, and New takes the component back at once when it holds no unfinished choices'],
  ],
};
const TICKET_MERGE: BoardEquivalent = {
  actions: ['merge-start', 'merge-retry', 'merge-ignore', 'merge-stop', 'merge-close', 'merge-close-target', 'merge-close-resolution', 'merge-acknowledge'],
  tests: [
    [MERGE, 'rewrites the kept ticket, links, marks and closes each source, after an opening Apply and one closing Apply'],
    [MERGE, 'after a failed link offers Retry, Ignore and Stop; Retry previews that one step, asks for no confirmation and the run carries on'],
    [MERGE, 'Ignore skips the failed step, and Stop ends the run keeping what is done and reports what is missing'],
    [MERGE, 'cut off mid-Apply, comes back with the steps saved so far and carries on from the first pending one on Retry'],
    [MERGE, 'does not move a flaw the report no longer lists: the kept ticket stays as it is and the closed source names the flaw'],
  ],
};
const EXPORT_OVERVIEW: BoardEquivalent = {
  exports: ['csv', 'xlsx'],
  tests: [
    [EXPORT, 'saves a CSV with the due-date columns, the overdue and due-before-release flags, and formula cells shown as text'],
    [EXPORT, 'saves an Excel workbook with date cells and the flag fills'],
  ],
};
const RELOAD: BoardEquivalent = {
  actions: ['reload-report'],
  tests: [[ACCEPTED, 'previews the choices it may drop, and after Apply keeps those whose rows still exist and names the others']],
};
const DEDUP: BoardEquivalent = {
  rule: 'The dedup search splits the report into New and Already ticketed when the board reads the import',
  tests: [
    [BOARD, 'shows a Veracode report with new and matched findings as tabs with their counts, in report order'],
    [BOARD, 'refuses a check whose dedup search failed, instead of showing matched findings as New'],
  ],
};
const FILE_CHOICE: BoardEquivalent = {
  rule: 'The start screen picks and parses the report file',
  tests: [
    [START, 'is chosen in the native dialog with the kind\'s file filter, and a cancelled dialog leaves the screen as it was'],
    [START, 'that does not parse shows the parse message, and Open stays disabled'],
    [START, 'with nothing that matches the filters shows the kind\'s no-match message'],
  ],
};
const TARGET_DESCRIPTIONS: BoardEquivalent = {
  rule: 'Reading the target tickets\' descriptions, and the dropped-member pass of a Waltz rewrite',
  tests: [
    [BOARD, 'opens with one unreadable target description: that row is not compared and the tab warns'],
    [TICKETED, 'a Waltz rewrite of a merged ticket whose member left the report drops its label and swaps the rating label'],
  ],
};

/** Every "Carry over" row of the ledger, and what keeps it on the import board. */
const BOARD_PARITY: Record<string, BoardEquivalent> = {
  // Reply commands
  'toggle-rows': SELECT_ROWS,
  bulk: SELECT_ROWS,
  create: {
    actions: ['new-create'],
    tests: [
      [NEW, 'creates one ticket per selected Veracode row with the template fields, the labels and the SLA Due Date'],
      [NEW, 'previews 50 of 72 selected rows and names the 22 left for the next Apply'],
      [NEW, 'keeps the tickets an interrupted create already made, and the next plan covers only the rest'],
    ],
  },
  fold: FOLD,
  'accept-cve': ACCEPT,
  'accept-component': ACCEPT,
  'accepted-list': ACCEPT,
  'row-action': {
    actions: ['ticketed-action'],
    tests: [
      [TICKETED, 'refuses an action the row does not offer'],
      [TICKETED, 'a new ticket for a resolved Waltz ticket is a full ticket linked to it'],
    ],
  },
  'all-action': {
    actions: ['ticketed-set-shown', 'ticketed-filter'],
    tests: [
      [TICKETED, 'sets all shown to leave on the Changed filter: only those 6 rows change, the 34 keep their own choice'],
      [TICKETED, 'skips the shown rows that do not offer the action and says how many'],
    ],
  },
  run: {
    actions: ['ticketed-apply'],
    tests: [
      [TICKETED, 'refuses a rewrite that covers only some rows of its ticket and writes nothing'],
      [TICKETED, 'rewrites the two rows of one ticket together, in one write'],
      [TICKETED, 'writes at most 50 tickets per Apply and says how many remain'],
    ],
  },
  'merge-tickets': TICKET_MERGE,
  'toggle-stale': {
    actions: ['toggle-stale'],
    tests: [
      [STALE, 'closes one marked Bug to Done with resolution Fixed without a native confirmation, though the write closes a ticket'],
      [STALE, 'shows a ticket without a discovered workflow but does not let it be selected'],
    ],
  },
  close: {
    actions: ['close-stale', 'stale-target', 'stale-resolution'],
    tests: [
      [STALE, 'closes a Bug group and a Task group with their own targets in one Apply, reporting each ticket as it finishes'],
      [STALE, 'asks for a resolution only for a closing target without a rule resolution'],
      [STALE, 'moves at most 50 tickets in one Apply and says how many remain'],
    ],
  },
  search: {
    actions: ['search'],
    tests: [
      [EXPORT, 'lists the matched tickets whose summary holds the word, with status and link, without asking Jira'],
      [EXPORT, 'says so when no matched ticket has the word in its summary'],
    ],
  },
  export: EXPORT_OVERVIEW,
  reload: RELOAD,

  'email-strip': {
    actions: ['cleanup-strip'],
    tests: [[CLEANUP, 'finds a pattern block, shows it, and strips it from the ticket while the file stays as it is']],
  },
  'email-keep': {
    actions: ['cleanup-keep'],
    tests: [[CLEANUP, 'keeps everything on keep, and then lets the tickets be created']],
  },
  'email-model-check': {
    actions: ['cleanup-check', 'cleanup-skip'],
    tests: [
      [CLEANUP, 'asks before any call, and continues without the model when the developer says no'],
      [CLEANUP, 'asks for a model when none is set, names every email and the model in the preview, and saves the pick'],
      [CLEANUP, 'marks an email whose check failed, keeps its blocks, and offers it again'],
    ],
  },
  'email-rows': {
    actions: ['cleanup-exclude'],
    tests: [[CLEANUP, 'leaves an email out of the strip when it is unticked']],
  },
  'email-save': {
    actions: ['cleanup-save'],
    tests: [[CLEANUP, 'saves a block the model found as a pattern']],
  },
  'email-cancel': {
    rule: 'Close on a board discards its session and closes its tab; nothing is imported',
    tests: [[MESSAGES, 'closes the tab when the page closes the board, and the session is gone']],
  },

  // Importer capabilities
  afterCreate: {
    actions: ['new-create'],
    tests: [
      [EMAIL, 'creates one ticket per email with its subject and uploads its attachment read from the file again'],
      [EMAIL, 'deletes the .eml after creating its ticket when the setting is on, without naming it as missing afterwards'],
    ],
  },
  fileFilter: FILE_CHOICE,
  filePickerTitle: FILE_CHOICE,
  parseAndFilter: FILE_CHOICE,
  searchLabelOf: DEDUP,
  dedupKeyOf: DEDUP,
  labelToDedupKey: DEDUP,
  onIssueTypeFetchFailed: {
    rule: 'The start screen warns when the project\'s issue types cannot be read',
    tests: [[START, 'shows the existing warning when the project\'s issue types cannot be read, and takes a typed one']],
  },
  stale: {
    actions: ['close-stale'],
    tests: [
      [STALE, 'closes one marked Bug to Done with resolution Fixed without a native confirmation, though the write closes a ticket'],
      [BOARD, 'shows Stale as unavailable when its search failed, and New and Already ticketed as usual'],
    ],
  },
  changeTracking: {
    actions: ['ticketed-filter'],
    tests: [[TICKETED, 'opens on the changed rows, and Unchanged and All show the others']],
  },
  deriveActions: {
    actions: ['ticketed-action'],
    tests: [
      [TICKETED, 'a new ticket for a resolved Waltz ticket is a full ticket linked to it'],
      [TICKETED, 'refuses an action the row does not offer'],
    ],
  },
  actionLabels: {
    actions: ['ticketed-action'],
    tests: [[TICKETED, 'a new ticket for a resolved Waltz ticket is a full ticket linked to it']],
  },
  readsTargetDescriptions: TARGET_DESCRIPTIONS,
  reportKeysOf: TARGET_DESCRIPTIONS,
  dueDateBackfill: {
    actions: ['ticketed-apply'],
    tests: [[TICKETED, 'flags an open ticket without a Due Date and defaults it to rewrite, which sets the date']],
  },
  // Veracode and Waltz never offer `update`, so these shape the labels, rating label and summary of a rewrite.
  recordLabelsOf: { actions: ['ticketed-apply'], tests: TARGET_DESCRIPTIONS.tests.slice(1) },
  removeLabelPrefix: { actions: ['ticketed-apply'], tests: TARGET_DESCRIPTIONS.tests.slice(1) },
  buildUpdateComment: { actions: ['ticketed-apply'], tests: TARGET_DESCRIPTIONS.tests.slice(1) },
  rewriteSummary: { actions: ['ticketed-apply'], tests: TARGET_DESCRIPTIONS.tests.slice(1) },
  accepted: ACCEPT,
  ticketMerge: {
    actions: [...TICKET_MERGE.actions!, ...RELOAD.actions!],
    tests: [
      ...TICKET_MERGE.tests,
      ...RELOAD.tests,
      [ACCEPTED, 'marks a New tab that holds a merge out of date, and Refresh brings the CVE\'s component back and keeps the merge'],
    ],
  },
  overviewExport: EXPORT_OVERVIEW,
  rewriteDueDate: {
    actions: ['ticketed-apply'],
    tests: [
      [TICKETED, 'a Veracode rewrite only moves the Due Date earlier'],
      [TICKETED, 'a Waltz rewrite takes the date of the regenerated group, even a later one'],
    ],
  },
  dueDateNote: {
    actions: ['ticketed-apply'],
    tests: [[TICKETED, 'flags an open ticket without a Due Date and defaults it to rewrite, which sets the date']],
  },

  // Rules with no command or capability of their own
  'Veracode SLA Due Date on create and new ticket (`ticketSidekick.veracode.slaDays`)': {
    actions: ['new-create'],
    tests: [[NEW, 'creates one ticket per selected Veracode row with the template fields, the labels and the SLA Due Date']],
  },
  'A Due Date Jira refuses is dropped and the write repeated once': {
    actions: ['new-create'],
    tests: [[NEW, 'drops a Due Date Jira refuses, creates the ticket once more without it and says so']],
  },
  'A drained import finishes without `done`': {
    rule: 'A board with no work left on any tab says so and offers Close',
    tests: [
      [BOARD, 'says there is nothing left to do when no tab has work'],
      [EXPORT, 'says there is nothing left to do, offers Close, and still saves the export'],
      [EMAIL, 'creates one ticket per email with its subject and uploads its attachment read from the file again'],
    ],
  },
  'Screens out of date after `unaccept` or a ticket merge': {
    rule: 'A changed tab refreshes at once without unfinished choices and is marked out of date otherwise',
    tests: [
      [ACCEPTED, 'marks a New tab that holds a merge out of date, and Refresh brings the CVE\'s component back and keeps the merge'],
      [ACCEPTED, 'removes a component entry, and New takes the component back at once when it holds no unfinished choices'],
      [MERGE, 'a finished merge marks Already ticketed out of date when it holds an unfinished choice and someone else changed it'],
    ],
  },
  'The accepted list is never written over a file that could not be read in full': {
    actions: ['accept-cve'],
    tests: [[ACCEPTED, 'refuses when the accepted list could not be read in full, says why, and leaves the file as it is']],
  },
  'Report and batch size limits': {
    rule: 'The start screen refuses a report over the kind\'s size limit',
    tests: [[START, 'is refused when it is over the kind\'s size limit, with the size message']],
  },
};

/** The code of the import board's modules, without comments. */
function boardSource(): string {
  const dir = resolve(root, 'src/boards/import');
  return readdirSync(dir)
    .filter(f => f.endsWith('.ts'))
    .map(f => readFileSync(resolve(dir, f), 'utf-8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Whether a test file declares a test with this exact title. */
function declaresTest(source: string, title: string): boolean {
  const quoted = [`'${title.replace(/'/g, "\\'")}'`, `"${title}"`, `\`${title}\``];
  return quoted.some(q => source.includes(`it(${q}`));
}

describe('import board parity ledger', () => {
  const rows = ledgerRows(ledgerSection());

  it('lists every reply command of the import review screens', () => {
    const missing = CHAT_COMMANDS.filter(id => !rows.has(id));
    expect(missing, 'commands with no row in the import board parity ledger').toEqual([]);
  });

  it('lists every optional capability an importer can supply', () => {
    const types = read('src/imports/descriptor.ts');
    const capabilities = [
      ...optionalMembers(types, 'ReportImportDescriptor'),
      ...optionalMembers(types, 'ImportChangeTracking'),
    ];
    expect(capabilities.length, 'capabilities were found in src/imports/descriptor.ts').toBeGreaterThan(10);
    const missing = capabilities.filter(name => !rows.has(name));
    expect(missing, 'capabilities with no row in the import board parity ledger').toEqual([]);
  });

  it('gives every row a decision', () => {
    const undecided = [...rows].filter(([, decision]) => !DECISIONS.includes(decision)).map(([name]) => name);
    expect(undecided, `rows whose decision is not one of ${DECISIONS.join(' / ')}`).toEqual([]);
  });

  it('maps every "Carry over" row to the board, and nothing else', () => {
    const carried = [...rows].filter(([, decision]) => decision === 'Carry over').map(([id]) => id);
    expect(carried.filter(id => !(id in BOARD_PARITY)), '"Carry over" rows with no board equivalent').toEqual([]);
    const extra = Object.keys(BOARD_PARITY).filter(id => rows.get(id) !== 'Carry over');
    expect(extra, 'map entries that are not a "Carry over" row').toEqual([]);
  });

  it('names for each row a board action, export or rule, and only actions and exports the import kind handles', () => {
    const source = boardSource();
    for (const [id, entry] of Object.entries(BOARD_PARITY)) {
      expect((entry.actions?.length ?? 0) + (entry.exports?.length ?? 0) + (entry.rule ? 1 : 0), `${id} names no board action, export or rule`).toBeGreaterThan(0);
      for (const action of entry.actions ?? []) {
        expect(source.includes(`'${action}'`), `${id}: the import kind does not handle the action '${action}'`).toBe(true);
      }
      for (const format of entry.exports ?? []) {
        expect(new RegExp(`format [!=]== '${format}'`).test(source), `${id}: the import kind does not save '${format}' files`).toBe(true);
      }
    }
  });

  it('proves each row with a board scenario test that exists', () => {
    const missing: string[] = [];
    for (const [id, entry] of Object.entries(BOARD_PARITY)) {
      expect(entry.tests.length, `${id} names no scenario test`).toBeGreaterThan(0);
      for (const [file, title] of entry.tests) {
        if (!declaresTest(read(`src/test/${file}`), title)) missing.push(`${id}: ${file} has no test "${title}"`);
      }
    }
    expect(missing).toEqual([]);
  });
});
