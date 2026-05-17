import * as vscode from 'vscode';
import { BitbucketApiClient } from '../bitbucket/BitbucketApiClient';
import type { ConfigService } from '../services/ConfigService';
import { PrReviewService } from '../services/PrReviewService';
import {
  parsePrUrl,
  parseDiff,
  resolveByNumber,
  extractJsonObject,
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
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    throw new Error(
      `LLM returned no JSON for review.\n\nRaw response (first 600 chars):\n${raw.slice(0, 600) || '(empty)'}`,
    );
  }
  try {
    const parsed = JSON.parse(jsonText);
    return {
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      additionalFilesNeeded: Array.isArray(parsed.additionalFilesNeeded) ? parsed.additionalFilesNeeded : [],
    };
  } catch (err) {
    throw new Error(
      `LLM returned malformed JSON: ${err instanceof Error ? err.message : String(err)}\n\nExtracted:\n${jsonText.slice(0, 400)}`,
    );
  }
}

async function handleCheck(
  stream: vscode.ChatResponseStream,
  configService: ConfigService,
): Promise<void> {
  const config = await configService.getBitbucketConfig();
  const isConfigured = config.authType === 'cloud'
    ? !!config.token
    : !!(config.baseUrl && config.token);
  if (!isConfigured) {
    stream.markdown(
      '**Bitbucket not configured.**\n\n' +
      'Run **Ticket Sidekick: Set Bitbucket Personal Access Token** (Data Center) or **Ticket Sidekick: Configure Bitbucket Cloud Credentials** from the Command Palette.',
    );
    return;
  }
  const effectiveUrl = config.authType === 'cloud' ? 'https://api.bitbucket.org' : config.baseUrl!;
  try {
    const client = new BitbucketApiClient({
      baseUrl: config.baseUrl ?? '',
      authType: config.authType,
      token: config.token!,
    });
    const user = await client.getCurrentUser();
    stream.markdown(
      `**Bitbucket connection OK**\n\n` +
      `| Setting | Value |\n|---|---|\n` +
      `| Base URL | \`${effectiveUrl}\` |\n` +
      `| Auth type | ${config.authType} |\n` +
      `| Logged in as | ${user.displayName} |\n`,
    );
  } catch (err) {
    stream.markdown(
      `**Bitbucket connection failed**\n\n` +
      `| Setting | Value |\n|---|---|\n` +
      `| Base URL | \`${effectiveUrl}\` |\n` +
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
    const isConfigured = config.authType === 'cloud'
      ? !!config.token
      : !!(config.baseUrl && config.token);
    if (!isConfigured) {
      stream.markdown(
        '**Bitbucket not configured.**\n\nRun **Ticket Sidekick: Set Bitbucket Personal Access Token** or **Ticket Sidekick: Configure Bitbucket Cloud Credentials** first.',
      );
      return;
    }

    const parsed = parsePrUrl(urlMatch[0]);
    if (!parsed) {
      stream.markdown(`Could not parse PR URL: \`${urlMatch[0]}\``);
      return;
    }

    const client = new BitbucketApiClient({
      baseUrl: config.baseUrl ?? '',
      authType: config.authType,
      token: config.token!,
    });
    const service = new PrReviewService(client);

    try {
      // Files are reviewed in chunks so each LLM call stays within context limits.
      // Adjust CHUNK_SIZE down for models with small context windows (e.g. 16 k → 5).
      const CHUNK_SIZE = 10;

      stream.markdown('_Fetching PR…_\n\n');
      const pr = await client.getPullRequest(parsed.project, parsed.repo, parsed.prId);
      const rawDiff = await client.getPullRequestDiff(parsed.project, parsed.repo, parsed.prId);
      const fileDiffs = parseDiff(rawDiff);

      const chunks: typeof fileDiffs[] = [];
      for (let i = 0; i < fileDiffs.length; i += CHUNK_SIZE) {
        chunks.push(fileDiffs.slice(i, i + CHUNK_SIZE));
      }

      let allFindings: Array<Omit<ReviewFinding, 'id'>> = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const from = i * CHUNK_SIZE + 1;
        const to = Math.min((i + 1) * CHUNK_SIZE, fileDiffs.length);
        const batchLabel = chunks.length > 1 ? ` · batch ${i + 1}/${chunks.length}` : '';
        stream.markdown(`_Analysing files ${from}–${to} of ${fileDiffs.length}${batchLabel}…_\n\n`);

        const chunkRaw = await callLLM(service.buildPrompt(pr, chunk), request.model, token);
        const { findings, additionalFilesNeeded } = await parseReviewResponse(chunkRaw);
        let chunkFindings = findings;

        if (additionalFilesNeeded.length > 0) {
          const capped = additionalFilesNeeded.slice(0, 5);
          const batchSuffix = chunks.length > 1 ? ` (batch ${i + 1})` : '';
          stream.markdown(`_Fetching ${capped.length} context file${capped.length !== 1 ? 's' : ''}${batchSuffix}…_\n\n`);
          const extraContents = await service.gatherFileContents(
            parsed.project, parsed.repo, pr.fromCommitHash,
            capped,
            makeWorkspaceReader,
          );
          const pass2Raw = await callLLM(service.buildPrompt(pr, chunk, extraContents), request.model, token);
          chunkFindings = (await parseReviewResponse(pass2Raw)).findings;
        }

        allFindings = allFindings.concat(chunkFindings);
      }

      const numbered = allFindings.map((f, i) => ({ ...f, id: i + 1 }));
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
