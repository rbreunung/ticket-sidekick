// The typed commands each import review screen accepts, in one place. The Commands line, the help
// text and the help after a refused reply are all built from this list, so they cannot disagree
// with each other. Pure (vscode-free); re-exported through ../sessionState.ts.
//
// Keep this module below the reply parsers and the screen builders: it imports neither, and it
// names the reply kinds an entry covers as plain strings (the guard test holds the typed record).

import { TICKETED_ACTION_ORDER } from '../../utils/reportImport';
import { ActionLabels, TicketedAction, actionLabelOf } from './importTypes';
import { cmdLink, neutralizeMarkdownLinks } from './primitives';

export const HELP_WORD = 'help';

export type CommandView = 'overview' | 'new' | 'ticketed' | 'stale' | 'email-preview';

/** What decides which commands a screen offers: the importer's capabilities and the shape of the review. */
export interface ImportCommandCaps {
  singleGroup?: boolean;
  canFold?: boolean;
  canAccept?: boolean;
  canMergeTickets?: boolean;
  canExport?: boolean;
  canSearch?: boolean;
  actionLabels?: ActionLabels;
  /** The actions some open Already-ticketed row offers; unset means every action (an importer with no labels of its own). */
  ticketedActions?: readonly TicketedAction[];
  /** Email cleanup preview: how many emails it lists, how many `model check` would still send, and whether a model-found block can still be saved. */
  emailRows?: number;
  emailModelCheckCount?: number;
  emailCanSave?: boolean;
}

export interface ImportCommandEntry {
  id: string;
  views: readonly CommandView[];
  /** The group label on the Commands line; may depend on the screen. */
  group?: string | ((view: CommandView) => string);
  /** The names shown on the Commands line, or null when the command appears in help only. */
  line: ((caps: ImportCommandCaps, view: CommandView) => string[]) | null;
  /** Syntax and effect, one or two sentences, for the help text. */
  help: (caps: ImportCommandCaps, view: CommandView) => string;
  /** The reply kinds this entry covers, as plain strings (the guard test maps every parser kind to an entry). */
  kinds: readonly string[];
  /** Replies that must parse to one of `kinds` on a screen that offers the entry. */
  samples: (caps: ImportCommandCaps, view: CommandView) => string[];
  when?: (caps: ImportCommandCaps, view: CommandView) => boolean;
}

/**
 * The actions some open Already-ticketed row offers, for an importer with its own action words; unset for one without,
 * which lists them all. Both the screens and the reply handler derive it here so the line and the help cannot disagree.
 */
export function offeredTicketedActions(
  actionLabels: ActionLabels | undefined,
  openRows: ReadonlyArray<{ allowedActions: readonly TicketedAction[] }>,
): TicketedAction[] | undefined {
  return actionLabels ? TICKETED_ACTION_ORDER.filter(a => openRows.some(r => r.allowedActions.includes(a))) : undefined;
}

const code = (text: string): string => `\`${text}\``;
const offeredActions = (caps: ImportCommandCaps): readonly TicketedAction[] => caps.ticketedActions ?? TICKETED_ACTION_ORDER;
const label = (action: TicketedAction, caps: ImportCommandCaps): string => actionLabelOf(action, caps.actionLabels);
/** `export` and `reload report` work from the overview, or from the only screen of a single-group import. */
const onOverviewOrOnly = (caps: ImportCommandCaps, view: CommandView): boolean => view === 'overview' || caps.singleGroup === true;

const SCREEN_VIEWS: readonly CommandView[] = ['overview', 'new', 'ticketed', 'stale'];

export const IMPORT_COMMAND_ENTRIES: readonly ImportCommandEntry[] = [
  // --- New ---
  {
    id: 'toggle-rows', views: ['new'], group: 'rows',
    line: () => ['2 4'],
    help: () => `${code('2 4')} toggles those rows on this page; only included rows are created.`,
    kinds: ['toggleRows'], samples: () => ['2 4'],
  },
  {
    id: 'bulk', views: ['new'], group: 'rows', line: null,
    help: () => `${code('include all')} / ${code('exclude all')} sets every row on this page.`,
    kinds: ['bulk'], samples: () => ['include all', 'exclude all'],
  },
  {
    id: 'create', views: ['new'], line: null,
    help: () => `${code('create tickets')} creates the included rows.`,
    kinds: ['create'], samples: () => ['create tickets'],
  },
  {
    id: 'fold', views: ['new'], group: 'group', when: caps => caps.canFold === true,
    line: () => ['merge', 'unmerge', 'add … to KEY'],
    help: () => `${code('merge 2 4')} combines rows on this page into one ticket; ${code('unmerge 2')} splits a merged row again; ` +
      `${code('add 2 4 to PROJ-123')} adds rows to an existing ticket, as a comment or a rewrite.`,
    kinds: ['merge', 'unmerge', 'addPrompt', 'add'],
    samples: () => ['merge 1 2', 'unmerge 3', 'add 1 2 to PROJ-1', 'add 1 2 to PROJ-1 as comment'],
  },
  {
    id: 'accept-cve', views: ['new'], group: 'hide', when: caps => caps.canAccept === true,
    line: () => ['accept CVE'],
    help: () => `${code('accept CVE 2 4 because …')} hides those rows' CVEs from this and future imports; add ${code('because …')} to record why.`,
    kinds: ['accept'], samples: () => ['accept CVE 2', 'accept cve 2 because not reachable'],
  },
  {
    id: 'accept-component', views: ['new', 'ticketed'], group: 'hide', when: caps => caps.canAccept === true,
    line: () => ['accept component'],
    help: (_caps, view) => `${code(view === 'ticketed' ? 'accept component A2 A3' : 'accept component 2 4')} stops offering those components at that exact version for good ` +
      '(add `because …` to record why): they also leave Already ticketed, and an open ticket is offered for closing under Stale.',
    kinds: ['acceptComponent'], samples: (_caps, view) => [view === 'ticketed' ? 'accept component A1' : 'accept component 2'],
  },
  {
    id: 'accepted-list', views: SCREEN_VIEWS, line: null,
    when: (caps, view) => caps.canAccept === true && (view === 'overview' || view === 'new' || caps.singleGroup === true),
    help: () => `${code('accepted')} lists what is accepted; ${code('unaccept 2')} removes an entry by its number.`,
    kinds: ['listAccepted', 'unaccept', 'unacceptEntry', 'unacceptComponent'],
    samples: () => ['accepted', 'unaccept 2', 'unaccept netty-codec CVE-2024-1', 'unaccept-component netty-codec 4.1.100'],
  },

  // --- Already ticketed ---
  {
    id: 'row-action', views: ['ticketed'], group: 'row',
    line: caps => offeredActions(caps).map(a => `A2 ${label(a, caps)}`),
    help: caps => `${code(`A2 ${label(offeredActions(caps).includes('follow-up') ? 'follow-up' : offeredActions(caps)[0], caps)}`)} sets one row's action ` +
      `(${offeredActions(caps).map(a => code(label(a, caps))).join(', ')}); you can also click an action in the table.`,
    kinds: ['setAction'], samples: caps => offeredActions(caps).map(a => `A1 ${label(a, caps)}`),
  },
  {
    id: 'all-action', views: ['ticketed'], group: 'all',
    line: caps => [`all ${label(offeredActions(caps).includes('leave') ? 'leave' : offeredActions(caps)[0], caps)}`],
    help: () => `${code('all <action>')} sets every row that offers that action, for example ${code('all leave')}.`,
    kinds: ['setAllActions'], samples: caps => [`all ${label(offeredActions(caps).includes('leave') ? 'leave' : offeredActions(caps)[0], caps)}`],
  },
  {
    id: 'run', views: ['ticketed'], line: null,
    help: caps => {
      const shortcuts = [
        !caps.ticketedActions || caps.ticketedActions.includes('update') ? code('update tickets') : '',
        !caps.ticketedActions || caps.ticketedActions.includes('re-create') ? code('re-create tickets') : '',
      ].filter(Boolean);
      return `${code('apply')} runs every row not set to leave, up to 50 per reply` +
        (shortcuts.length > 0 ? `; ${shortcuts.join(' and ')} run only that kind.` : '.');
    },
    kinds: ['apply', 'update', 'recreate'],
    samples: caps => [
      'apply',
      ...(!caps.ticketedActions || caps.ticketedActions.includes('update') ? ['update tickets'] : []),
      ...(!caps.ticketedActions || caps.ticketedActions.includes('re-create') ? ['re-create tickets'] : []),
    ],
  },
  {
    id: 'merge-tickets', views: ['overview', 'ticketed'], group: 'tickets', when: caps => caps.canMergeTickets === true,
    line: (_caps, view) => (view === 'ticketed' ? ['merge A5 into A3'] : []),
    help: () => `${code('merge A5 A6 into A3')} (or ticket keys) combines tickets into one: the ticket after ${code('into')} is kept and the others are closed. You confirm first.`,
    kinds: ['mergeTicketsPrompt', 'mergeTickets'], samples: () => ['merge A1 into A3', 'merge A1 into A3 confirm'],
  },

  // --- Stale ---
  {
    id: 'toggle-stale', views: ['stale'], group: 'toggle',
    line: () => ['PROJ-123'],
    help: () => `${code('PROJ-123')} marks a stale ticket for closing (reply it again to unmark); tickets marked on any page are closed together.`,
    kinds: ['toggleStale'], samples: () => ['PROJ-1'],
  },
  {
    id: 'close', views: ['stale'], line: null,
    help: () => `${code('close tickets')} closes the marked tickets; you pick the target status next.`,
    kinds: ['close'], samples: () => ['close tickets'],
  },

  // --- Ticket search (New and Already ticketed) ---
  {
    id: 'search', views: ['new', 'ticketed'], group: view => (view === 'ticketed' ? 'tickets' : 'find'),
    when: caps => caps.canSearch === true,
    line: () => ['search'],
    help: (caps, view) => `${code('search netty')} lists the open tickets this review matched whose summary contains every word` +
      (view === 'new' && caps.canFold ? `; ${code('merge 2 4 into A3')} (or a ticket key) adds New rows to one of them.` : '.'),
    kinds: ['search'], samples: () => ['search netty'],
  },
  {
    id: 'show', views: SCREEN_VIEWS, line: null, when: caps => caps.canSearch === true,
    help: () => `${code('show')} prints this screen again.`,
    kinds: ['show'], samples: () => ['show'],
  },

  // --- Shared by the group screens and the overview ---
  {
    id: 'export', views: SCREEN_VIEWS, line: null, when: (caps, view) => caps.canExport === true && onOverviewOrOnly(caps, view),
    help: () => `${code('export')} lists this report's items by Fix Version, compared with Jira; ${code('export csv')} and ${code('export xlsx')} also save a file.`,
    kinds: ['export'], samples: () => ['export', 'export csv', 'export xlsx'],
  },
  {
    id: 'reload', views: SCREEN_VIEWS, line: null, when: (caps, view) => caps.canMergeTickets === true && onOverviewOrOnly(caps, view),
    help: () => `${code('reload report')} re-reads the report file and refreshes these screens after you confirm.`,
    kinds: ['reloadPrompt', 'reload'], samples: () => ['reload report', 'reload report confirm'],
  },
  {
    id: 'paging', views: ['new', 'ticketed', 'stale'], line: null,
    help: (caps, view) => `${code('next')} / ${code('prev')} / ${code('page 3')} move between pages` +
      (view === 'ticketed' ? '; actions apply to rows on every page.'
        : view === 'stale' ? '; tickets marked on any page are closed together.'
          : caps.canFold ? '; a toggle or merge lasts only for its page.' : '; a toggle lasts only for its page.'),
    kinds: ['pageNav'], samples: () => ['next', 'prev', 'page 2'],
  },
  {
    id: 'open', views: ['overview'], line: null,
    help: () => `${code('open new')}, ${code('open already ticketed')} and ${code('open stale')} open a group.`,
    kinds: ['open'], samples: () => ['open new'],
  },
  {
    id: 'exit', views: SCREEN_VIEWS, line: null,
    help: (caps, view) => (view === 'overview' || caps.singleGroup ? `${code('done')} finishes this import.` : `${code('back')} returns to the overview.`),
    kinds: ['done', 'back'], samples: (caps, view) => (view === 'overview' || caps.singleGroup ? ['done'] : ['back', 'done']),
  },
  {
    id: 'help', views: [...SCREEN_VIEWS, 'email-preview'], line: null,
    help: () => `${code(HELP_WORD)} prints this list again.`,
    kinds: ['help'], samples: () => [HELP_WORD],
  },

  // --- Email cleanup preview ---
  {
    id: 'email-strip', views: ['email-preview'], group: 'clean up',
    line: () => ['strip'],
    help: () => `${code('strip')} removes the blocks listed above before the email(s) are imported.`,
    kinds: ['strip'], samples: () => ['strip'],
  },
  {
    id: 'email-keep', views: ['email-preview'], group: 'clean up',
    line: () => ['keep'],
    help: () => `${code('keep')} imports the email(s) unchanged.`,
    kinds: ['keep'], samples: () => ['keep'],
  },
  {
    id: 'email-model-check', views: ['email-preview'], group: 'clean up', when: caps => (caps.emailModelCheckCount ?? 0) > 0,
    line: () => ['model check'],
    help: caps => `${code('model check')} lets the Copilot model look for more boilerplate in the ${caps.emailModelCheckCount} email(s) it has not checked yet; nothing is sent unless you reply.`,
    kinds: ['model-check'], samples: () => ['model check'],
  },
  {
    id: 'email-rows', views: ['email-preview'], group: 'rows', when: caps => (caps.emailRows ?? 0) > 1,
    line: () => ['3'],
    help: () => `${code('3')} (or ${code('2, 4')}) excludes that email from stripping and from the model check; reply it again to include it.`,
    kinds: ['toggle'], samples: () => ['1'],
  },
  {
    id: 'email-save', views: ['email-preview'], group: 'patterns', when: caps => caps.emailCanSave === true,
    line: () => ['save <n>'],
    help: () => `${code('save 2')} stores block #2, which the model found, as a pattern in your settings so the next import finds it without the model.`,
    kinds: ['save'], samples: () => ['save 1'],
  },
  {
    id: 'email-cancel', views: ['email-preview'], line: null,
    help: () => `${code('cancel')} stops without importing anything.`,
    kinds: ['cancel'], samples: () => ['cancel'],
  },
];

export function commandEntriesFor(view: CommandView, caps: ImportCommandCaps): ImportCommandEntry[] {
  return IMPORT_COMMAND_ENTRIES.filter(e => e.views.includes(view) && (e.when ? e.when(caps, view) : true));
}

const VIEW_TITLES: Record<CommandView, string> = {
  overview: 'Overview',
  new: 'New screen',
  ticketed: 'Already ticketed screen',
  stale: 'Stale screen',
  'email-preview': 'Email cleanup preview',
};

export function buildHelpLink(): string {
  return cmdLink('help', HELP_WORD);
}

/** `Commands: rows `2 4` · group `merge` … · [help]`, from the entries this screen offers; just the link when none list a name. */
export function buildCommandsLine(view: CommandView, caps: ImportCommandCaps): string {
  const groups = new Map<string, string[]>();
  for (const entry of commandEntriesFor(view, caps)) {
    if (!entry.line) continue;
    const items = entry.line(caps, view);
    if (items.length === 0) continue;
    const name = typeof entry.group === 'function' ? entry.group(view) : (entry.group ?? '');
    groups.set(name, [...(groups.get(name) ?? []), ...items]);
  }
  const parts = [...groups].map(([name, items]) => `${name} ${items.map(code).join(' ')}`.trim());
  return groups.size === 0 ? buildHelpLink() : `Commands: ${[...parts, buildHelpLink()].join(' · ')}`;
}

export function buildImportHelp(view: CommandView, caps: ImportCommandCaps): string {
  const bullets = commandEntriesFor(view, caps).map(e => `- ${e.help(caps, view)}`);
  return [`**Help — ${VIEW_TITLES[view]}**`, '', ...bullets].join('\n');
}

const QUOTE_LIMIT = 80;

/** A reply as a single inline-code span: no line breaks, no backticks to break out of the span, capped. */
function quoteTyped(typed: string): string {
  const flat = typed.replace(/\s+/g, ' ').replace(/`/g, "'").trim();
  return flat.length > QUOTE_LIMIT ? `${flat.slice(0, QUOTE_LIMIT)}…` : flat;
}

/**
 * What a refused reply streams: the parser's specific reason when there is one, otherwise a short quote of what was
 * typed, then the screen's full help. Both parts can carry the user's own text, so each is made inert here.
 */
export function buildRefusedReply(input: { view: CommandView; caps: ImportCommandCaps; typed?: string; reason?: string }): string {
  const typed = input.typed ? quoteTyped(input.typed) : '';
  const lead = input.reason
    ? neutralizeMarkdownLinks(input.reason)
    : typed ? `Didn't understand ${code(typed)}.` : "Didn't understand that.";
  return `${lead}\n\n${buildImportHelp(input.view, input.caps)}`;
}
