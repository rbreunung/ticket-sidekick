import * as vscode from 'vscode';
import { BitbucketApiClient } from '../bitbucket/BitbucketApiClient';
import type { ConfigService } from '../services/ConfigService';
import { PrReviewService } from '../services/PrReviewService';
import {
  parsePrUrl,
  parseDiff,
  resolveByNumber,
  type ReviewFinding,
  type ReviewSession,
} from './reviewSessionState';

function getLastAssistantText(chatContext: vscode.ChatContext): string {
  for (let i = chatContext.history.length - 1; i >= 0; i--) {
    const item = chatContext.history[i];
    if (item instanceof vscode.ChatResponseTurn) {
      return item.response
        .map((p) => (p instanceof vscode.ChatResponseMarkdownPart ? p.value.value : ''))
        .join('');
    }
  }
  return '';
}

const FOLLOW_UP_PROMPT_PREFIX = `A developer is asking a follow-up question about a specific finding from a code review. Provide a thorough explanation that directly addresses their question. Include: whether their assumption is valid, specific conditions under which this could be acceptable or needs fixing, and any concrete code changes that would apply.

Finding:
`;

async function callLLM(
  prompt: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<string> {
  const response = await model.sendRequest(
    [vscode.LanguageModelChatMessage.User(prompt)],
    {},
    token,
  );
  let text = '';
  for await (const chunk of response.text) {
    text += chunk;
  }
  return text.trim();
}

async function parseReviewResponse(raw: string): Promise<{
  findings: Array<Omit<ReviewFinding, 'id'>>;
  additionalFilesNeeded: string[];
}> {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('LLM returned no valid JSON for review. Response: ' + raw.slice(0, 200));
  return JSON.parse(jsonMatch[0]);
}

async function handleCheck(
  stream: vscode.ChatResponseStream,
  configService: ConfigService,
): Promise<void> {
  const config = await configService.getBitbucketConfig();
  if (!config.baseUrl || !config.token) {
    stream.markdown(
      '**Bitbucket not configured.**\n\n' +
      'Run **Ticket Sidekick: Set Bitbucket PAT** (Data Center) or **Ticket Sidekick: Configure Bitbucket Cloud** from the Command Palette.',
    );
    return;
  }
  try {
    const client = new BitbucketApiClient({
      baseUrl: config.baseUrl,
      authType: config.authType,
      token: config.token,
    });
    const user = await client.getCurrentUser();
    stream.markdown(
      `**Bitbucket connection OK**\n\n` +
      `| Setting | Value |\n|---|---|\n` +
      `| Base URL | \`${config.baseUrl}\` |\n` +
      `| Auth type | ${config.authType} |\n` +
      `| Logged in as | ${user.displayName} |\n`,
    );
  } catch (err) {
    stream.markdown(
      `**Bitbucket connection failed**\n\n` +
      `| Setting | Value |\n|---|---|\n` +
      `| Base URL | \`${config.baseUrl}\` |\n` +
      `| Auth type | ${config.authType} |\n\n` +
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function makeWorkspaceReader(path: string): Promise<string | null> {
  const files = await vscode.workspace.findFiles(`**/${path}`, '**/node_modules/**', 1);
  if (files.length === 0) return null;
  const bytes = await vscode.workspace.fs.readFile(files[0]);
  return Buffer.from(bytes).toString('utf-8');
}

export function createBitbucketParticipant(
  context: vscode.ExtensionContext,
  configService: ConfigService,
): vscode.ChatParticipant {
  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<void> => {
    const prompt = request.prompt.trim();

    // 1. check command
    if (/^check\b/i.test(prompt)) {
      await handleCheck(stream, configService);
      return;
    }

    const ws = context.workspaceState;
    const lastResponse = getLastAssistantText(chatContext);

    // 2. Multi-turn follow-up on an existing review
    if (lastResponse.includes('<!-- bitbucket:review-session -->')) {
      const session = ws.get<ReviewSession>('bitbucket.session.review');
      if (session) {
        const exactFinding = resolveByNumber(prompt, session.findings);
        let finding: ReviewFinding | undefined;

        if (exactFinding) {
          finding = exactFinding;
        } else {
          const matchPrompt =
            `The developer asked: "${prompt}"\n\n` +
            `Available findings:\n${session.findings.map((f) => `#${f.id}: [${f.severity}] ${f.title} (${f.file})`).join('\n')}\n\n` +
            `Reply with ONLY the finding number (e.g. "2") that best matches the question, or "none" if no match.`;
          const matchRaw = await callLLM(matchPrompt, request.model, token);
          const num = parseInt(matchRaw.trim(), 10);
          finding = isNaN(num) ? undefined : session.findings.find((f) => f.id === num);
        }

        if (!finding) {
          stream.markdown(`_Could not match your question to a specific finding. Try referencing by number, e.g. **#2**._\n\n<!-- bitbucket:review-session -->`);
          return;
        }

        const followUpPrompt =
          FOLLOW_UP_PROMPT_PREFIX +
          `File: ${finding.file}${finding.line ? `, Line: ${finding.line}` : ''}\n` +
          `Severity: ${finding.severity}\n` +
          `Title: ${finding.title}\n` +
          `Description: ${finding.description}\n` +
          `Recommendation: ${finding.recommendation}\n\n` +
          `Developer's question: ${prompt}`;

        const answer = await callLLM(followUpPrompt, request.model, token);
        stream.markdown(`**Finding #${finding.id} — ${finding.title}**\n\n${answer}\n\n<!-- bitbucket:review-session -->`);
        return;
      }
    }

    // 3. New review — extract URL from prompt
    const urlMatch = prompt.match(/https?:\/\/\S+\/pull-requests\/\d+\S*/);
    if (!urlMatch) {
      stream.markdown(
        'Point me at a PR to review:\n\n' +
        '`@bitbucket https://bitbucket.company.com/projects/PROJ/repos/myrepo/pull-requests/42`\n\n' +
        'Or run `@bitbucket check` to verify your connection.',
      );
      return;
    }

    const config = await configService.getBitbucketConfig();
    if (!config.baseUrl || !config.token) {
      stream.markdown(
        '**Bitbucket not configured.**\n\nRun **Ticket Sidekick: Set Bitbucket PAT** or **Ticket Sidekick: Configure Bitbucket Cloud** first.',
      );
      return;
    }

    const parsed = parsePrUrl(urlMatch[0], config.baseUrl);
    if (!parsed) {
      stream.markdown(`Could not parse PR URL: \`${urlMatch[0]}\``);
      return;
    }

    const client = new BitbucketApiClient({
      baseUrl: config.baseUrl,
      authType: config.authType,
      token: config.token,
    });
    const service = new PrReviewService(client);

    try {
      stream.markdown('_Fetching PR…_\n\n');
      const pr = await client.getPullRequest(parsed.project, parsed.repo, parsed.prId);
      const rawDiff = await client.getPullRequestDiff(parsed.project, parsed.repo, parsed.prId);
      const fileDiffs = parseDiff(rawDiff);

      stream.markdown(`_Gathering context for ${fileDiffs.length} file${fileDiffs.length !== 1 ? 's' : ''}…_\n\n`);
      const fileContents = await service.gatherFileContents(
        parsed.project, parsed.repo, pr.fromCommitHash,
        fileDiffs.map((f) => f.path),
        makeWorkspaceReader,
      );

      stream.markdown('_Analysing…_\n\n');
      const pass1Raw = await callLLM(service.buildPrompt(pr, fileDiffs, fileContents), request.model, token);
      const pass1 = await parseReviewResponse(pass1Raw);

      let findings = pass1.findings;

      if (pass1.additionalFilesNeeded.length > 0) {
        const capped = pass1.additionalFilesNeeded.slice(0, 5);
        stream.markdown(`_Fetching ${capped.length} additional context file${capped.length !== 1 ? 's' : ''}…_\n\n`);
        const extraContents = await service.gatherFileContents(
          parsed.project, parsed.repo, pr.fromCommitHash,
          capped,
          makeWorkspaceReader,
        );
        const allContents = new Map([...fileContents, ...extraContents]);
        const pass2Raw = await callLLM(service.buildPrompt(pr, fileDiffs, allContents), request.model, token);
        const pass2 = await parseReviewResponse(pass2Raw);
        findings = pass2.findings;
      }

      const numbered = findings.map((f, i) => ({ ...f, id: i + 1 }));
      const output = service.formatReview(numbered, pr, fileDiffs.length);
      stream.markdown(output);

      await ws.update('bitbucket.session.review', {
        prTitle: pr.title,
        prUrl: urlMatch[0],
        findings: numbered,
      } satisfies ReviewSession);
    } catch (err) {
      stream.markdown(`**Review failed:** ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const participant = vscode.chat.createChatParticipant('ticket-sidekick.bitbucket', handler);
  context.subscriptions.push(participant);
  return participant;
}
