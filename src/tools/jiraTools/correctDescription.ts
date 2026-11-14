import { z } from 'zod';
import type { TicketService } from '../../services/TicketService';
import { applyCorrections, type Correction, type RefusalReason, type RefusedCorrection } from '../../utils/descriptionCorrections';
import { fingerprint } from '../../tools/recentCallGuard';
import { defineTool } from '../toolDefinition';
import type { JiraToolDeps } from './jiraAccess';
import { previewTicketService, runJiraTool } from './runJiraTool';
import { ticketKeyProblem } from './ticketKeyInput';
import { CORRECT_DESCRIPTION_TOOL, VIEW_TICKET_TOOL } from './toolNames';
import { writeOnce } from './writeGuard';

// Writes spelling and grammar corrections the developer approved into a ticket's description. The
// corrections are applied to the description as Jira stores it, so nothing but the listed text
// changes; the agent reads the ticket as Markdown and never writes the whole description itself.

const correctionsShape = {
  ticketKey: z.string().describe('The ticket key, e.g. PROJ-123.'),
  corrections: z.array(z.object({
    before: z.string().describe('The text to replace: the shortest plain-text fragment that is unique in the description, e.g. the misspelled word and the word next to it. Never across bold, italic or other formatting.'),
    after: z.string().describe('The corrected text.'),
  })).min(1).describe('The corrections the user approved, in the order they were shown.'),
};

const REASONS: Record<RefusalReason, string> = {
  empty: 'no text to replace was given',
  'not found': 'the text is not in the description (any more)',
  'not unique': 'the text appears more than once; give a longer fragment',
  protected: 'the text is inside code, monospace, a link target, a web address or an image, which are never corrected',
  overlaps: 'the text overlaps another correction',
  'adds markup': 'the corrected text adds wiki markup (an image, a link, a macro or a table cell), which a spelling fix never needs',
};

function describeCorrections(corrections: readonly Correction[]): string {
  return corrections.map((c, i) => `${i + 1}. ${c.before} → ${c.after}`).join('\n');
}

function describeRefusal(refused: readonly RefusedCorrection[]): string {
  return refused.map(r => `${r.number}. "${r.before}": ${REASONS[r.reason]}`).join('\n');
}

type CorrectionPlan =
  | { text: string }
  | { problem: string }
  | { refused: RefusedCorrection[] };

/** The corrected description as it would be written now, or why nothing would be written. */
async function planCorrections(ticketService: TicketService, key: string, corrections: readonly Correction[]): Promise<CorrectionPlan> {
  const raw = await ticketService.getRawField(key, 'description');
  if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim())) return { problem: `${key} has no description.` };
  if (typeof raw !== 'string') return { problem: `The description of ${key} is not stored as wiki text, so it cannot be corrected here.` };
  return applyCorrections(raw, corrections);
}

export const correctDescriptionTool = defineTool<JiraToolDeps, typeof correctionsShape>({
  name: CORRECT_DESCRIPTION_TOOL,
  title: 'Correct the description of a Jira ticket',
  description:
    'Applies spelling and grammar corrections the user approved to one ticket\'s description, and changes nothing else: '
    + 'formatting, tables, code, links and mentions stay exactly as they are. '
    + `Read the ticket with ${VIEW_TICKET_TOOL} first and show the user the numbered corrections before calling this. `
    + 'Each correction must match exactly once and must not be inside code, monospace, a link target or a web address; '
    + 'if any correction does not fit, nothing is written and the answer names each one that did not fit. '
    + 'The same corrections to the same ticket within a minute are skipped.',
  inputSchema: correctionsShape,
  annotations: { destructiveHint: true },
  preview: async (args, deps) => {
    const key = args.ticketKey.trim();
    const problem = ticketKeyProblem(key);
    if (problem) return [{ name: 'Will be refused', value: problem }];
    const jira = await previewTicketService(deps);
    if (!jira) return [];
    const plan = await planCorrections(jira.ticketService, key, args.corrections);
    if ('text' in plan) return [{ name: 'Resulting description', value: plan.text }];
    return [{ name: 'Will be refused', value: 'problem' in plan ? plan.problem : describeRefusal(plan.refused) }];
  },
  handler: async (args, deps) => {
    const key = args.ticketKey.trim();
    const problem = ticketKeyProblem(key);
    if (problem) return problem;

    return writeOnce(
      deps.recentWrites,
      fingerprint(CORRECT_DESCRIPTION_TOOL, key, JSON.stringify(args.corrections)),
      `Skipped: the same corrections were written to ${key} within the last minute.`,
      markWritten => runJiraTool(deps, CORRECT_DESCRIPTION_TOOL, `Could not correct the description of ${key}`, async ({ ticketService }) => {
        const plan = await planCorrections(ticketService, key, args.corrections);
        if ('problem' in plan) return `${plan.problem} Nothing was changed.`;
        if ('refused' in plan) {
          return `Nothing was changed on ${key}. These corrections do not fit:\n\n${describeRefusal(plan.refused)}\n\n`
            + 'Drop them, or give a longer or plainer fragment, and call again with the rest.';
        }
        const outcome = await ticketService.updateFieldOutcome(key, 'description', plan.text);
        if (!outcome.written) return outcome.message;
        markWritten();
        const n = args.corrections.length;
        return `Corrected the description of ${key}: ${n} correction${n === 1 ? '' : 's'}.\n\n${describeCorrections(args.corrections)}`;
      }),
    );
  },
});
