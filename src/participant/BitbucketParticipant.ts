import * as vscode from 'vscode';
import { minimatch } from 'minimatch';
import { BitbucketApiClient } from '../bitbucket/BitbucketApiClient';
import type { BitbucketConfig } from '../bitbucket/IBitbucketClient';
import type { ConfigService } from '../services/ConfigService';
import { PrReviewService } from '../services/PrReviewService';
import {
  parsePrUrl,
  parseDiff,
  resolveByNumber,
  resolveByNumbers,
  isAddToReviewIntent,
  extractUserNote,
  extractJsonObject,
  buildAdaptiveChunks,
  annotateWithLineTypes,
  type ReviewFinding,
  type ReviewSession,
  type BitbucketCommentPreviewSession,
} from './reviewSessionState';
import { isConfirmation, isCancellation } from './sessionState';
import { generateContent } from './jira/llmHelpers';
import { redactUrls, tokenStatus } from '../utils/diagUtils';

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

const FOLLOW_UP_PROMPT_PREFIX = `A developer is asking a follow-up question about a specific finding from a code review. Answer their question directly and thoroughly. If they state an assumption, evaluate it. Include specific conditions under which this could be acceptable or needs fixing, and any concrete code changes where relevant.

Finding:
`;

async function callLLM(
  prompt: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  onChunk?: (totalChars: number) => void,
): Promise<string> {
  const response = await model.sendRequest(
    [vscode.LanguageModelChatMessage.User(prompt)],
    {},
    token,
  );
  let text = '';
  for await (const chunk of response.text) {
    text += chunk;
    onChunk?.(text.length);
  }
  return text.trim();
}

async function callLLMWithProgress(
  prompt: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  statusMessage: string,
): Promise<string> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Ticket Sidekick' },
    (progress) => callLLM(prompt, model, token, (chars) => {
      progress.report({ message: `${statusMessage} · ${chars.toLocaleString()} chars…` });
    }),
  );
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
  config: BitbucketConfig,
): Promise<void> {
  const isConfigured = config.authType === 'cloud'
    ? !!config.token
    : !!(config.baseUrl && config.token);
  if (!isConfigured) {
    const urlStatus = config.authType === 'cloud'
      ? 'n/a (Cloud)'
      : (config.baseUrl ? 'present' : '**absent** — add `ticketSidekick.bitbucket.baseUrl` to VS Code settings');
    stream.markdown(
      '**Bitbucket not configured.**\n\n' +
      `| Setting | Status |\n|---|---|\n` +
      `| Auth type | ${config.authType} |\n` +
      `| Base URL | ${urlStatus} |\n` +
      `| Token | ${tokenStatus(config.token)} |\n\n` +
      'Run **Ticket Sidekick: Set Bitbucket Personal Access Token** (Data Center) or **Ticket Sidekick: Configure Bitbucket Cloud Credentials** from the Command Palette.',
    );
    return;
  }
  const effectiveUrl = config.authType === 'cloud' ? 'https://api.bitbucket.org' : config.baseUrl!;
  const apiVersion = config.authType === 'cloud' ? 'v2.0' : 'v1.0';
  const displayUrl = redactUrls(effectiveUrl);
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
      `| Base URL | \`${displayUrl}\` |\n` +
      `| API version | ${apiVersion} |\n` +
      `| Auth type | ${config.authType} |\n` +
      `| Token | ${tokenStatus(config.token)} |\n` +
      `| Logged in as | ${user.displayName} |\n`,
    );
  } catch (err) {
    stream.markdown(
      `**Bitbucket connection failed**\n\n` +
      `| Setting | Value |\n|---|---|\n` +
      `| Base URL | \`${displayUrl}\` |\n` +
      `| API version | ${apiVersion} |\n` +
      `| Auth type | ${config.authType} |\n` +
      `| Token | ${tokenStatus(config.token)} |\n\n` +
      `Error: ${redactUrls(err instanceof Error ? err.message : String(err))}`,
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
    const config = await configService.getBitbucketConfig();

    // 1. check command
    if (/^check\b/i.test(prompt)) {
      await handleCheck(stream, config);
      return;
    }

    if (config.showConnectionInfo) {
      const effectiveUrl = config.authType === 'cloud' ? 'https://api.bitbucket.org' : (config.baseUrl ?? '(not set)');
      const apiVersion = config.authType === 'cloud' ? 'v2.0' : 'v1.0';
      stream.markdown(`_${effectiveUrl} · API ${apiVersion} · ${config.authType}_\n\n`);
    }

    const ws = context.workspaceState;
    const lastResponse = getLastAssistantText(chatContext);
    const prUrlMatch = prompt.match(/https?:\/\/\S+\/pull-requests\/\d+\S*/);

    // Helper: stream a comment preview and save session
    const streamCommentPreview = async (previewSession: BitbucketCommentPreviewSession) => {
      await ws.update('bitbucket.session.commentPreview', previewSession);
      const n = previewSession.items.length;
      const parts: string[] = [`**Preview: ${n} comment${n !== 1 ? 's' : ''} to post**`];
      const allInline = previewSession.items.every(i => i.finding.lineType !== undefined);
      for (const { finding, text } of previewSession.items) {
        const anchorLine = finding.lineType !== undefined
          ? `📌 _Inline comment on line ${finding.line} of \`${finding.file}\`_`
          : finding.line !== undefined
            ? `⚠️ _Line ${finding.line} could not be located in the diff — will fall back to activity feed comment_`
            : `⚠️ _No line number — will be posted to activity feed_`;
        parts.push(`---\n\n**#${finding.id}** — ${finding.title}\n${anchorLine}\n\n${text}`);
      }
      const postLabel = allInline ? 'post inline' : 'post to activity feed';
      parts.push(`---\n\nReply **"post it"** to ${postLabel}, give a refinement instruction, or **(c)** to cancel.\n\n<!-- bitbucket:comment-preview -->`);
      stream.markdown(parts.join('\n\n'));
    };

    // Helper: post results and format report
    const postAndReport = async (previewSession: BitbucketCommentPreviewSession) => {
      await ws.update('bitbucket.session.commentPreview', undefined);
      stream.markdown(`_Posting ${previewSession.items.length} comment${previewSession.items.length !== 1 ? 's' : ''} to Bitbucket…_\n\n`);
      const client = new BitbucketApiClient({
        baseUrl: config.baseUrl ?? '',
        authType: config.authType,
        token: config.token!,
      });
      const service = new PrReviewService(client);
      const results = await service.postCommentItems(
        previewSession.project, previewSession.repo, previewSession.prId, previewSession.items,
      );
      const successLines: string[] = [];
      const failureLines: string[] = [];
      for (const r of results) {
        if (r.result) {
          const ref = r.result.commentUrl
            ? `[comment #${r.result.commentId}](${r.result.commentUrl})`
            : `comment #${r.result.commentId}`;
          const anchor = r.finding.lineType !== undefined ? `inline on L${r.finding.line}` : 'activity feed';
          successLines.push(`- **#${r.finding.id}** ${r.finding.title} → posted as ${ref} (${anchor})`);
        } else {
          failureLines.push(`- **#${r.finding.id}** ${r.finding.title} → failed: ${r.error}`);
        }
      }
      let output = '';
      if (successLines.length > 0) output += `**Posted ${successLines.length} comment${successLines.length !== 1 ? 's' : ''}:**\n\n${successLines.join('\n')}\n\n`;
      if (failureLines.length > 0) output += `**Failed to post ${failureLines.length} comment${failureLines.length !== 1 ? 's' : ''}:**\n\n${failureLines.join('\n')}\n\n`;
      stream.markdown(output + `<!-- bitbucket:review-session -->`);
    };

    // 2a. Comment preview — confirmation, cancellation, or refinement
    if (!prUrlMatch && lastResponse.includes('<!-- bitbucket:comment-preview -->')) {
      const previewSession = ws.get<BitbucketCommentPreviewSession>('bitbucket.session.commentPreview');
      if (previewSession) {
        if (isCancellation(prompt)) {
          await ws.update('bitbucket.session.commentPreview', undefined);
          stream.markdown(`_Cancelled._\n\n<!-- bitbucket:review-session -->`);
          return;
        }
        if (isConfirmation(prompt)) {
          await postAndReport(previewSession);
          return;
        }
        // Refinement — revise each comment text with the instruction, one LLM call per item
        const revisedItems: Array<{ finding: ReviewFinding; text: string }> = [];
        for (const item of previewSession.items) {
          const instruction = `Revise the following Bitbucket PR comment based on this instruction: "${prompt}"\n\nOriginal comment:\n${item.text}`;
          const revised = await generateContent(instruction, request.model, token, undefined, 'generate');
          revisedItems.push({ finding: item.finding, text: revised || item.text });
        }
        await streamCommentPreview({ ...previewSession, items: revisedItems });
        return;
      }
    }

    // 2b. Multi-turn follow-up on an existing review
    if (!prUrlMatch && lastResponse.includes('<!-- bitbucket:review-session -->')) {
      const session = ws.get<ReviewSession>('bitbucket.session.review');
      if (session) {
        if (isAddToReviewIntent(prompt)) {
          if (!session.project || !session.repo || !session.prId) {
            stream.markdown(`_Session is from an older version — start a new review to use "add to review"._\n\n<!-- bitbucket:review-session -->`);
            return;
          }
          const selectedFindings = resolveByNumbers(prompt, session.findings);
          if (selectedFindings.length === 0) {
            stream.markdown(`_No matching findings. Use **#N** references, e.g. **#2 #3 add to review**._\n\n<!-- bitbucket:review-session -->`);
            return;
          }
          const userNote = extractUserNote(prompt) || undefined;
          const service = new PrReviewService(new BitbucketApiClient({
            baseUrl: config.baseUrl ?? '',
            authType: config.authType,
            token: config.token!,
          }));
          const items = selectedFindings.map(f => ({ finding: f, text: service.formatPrComment(f, userNote) }));
          const previewSession: BitbucketCommentPreviewSession = {
            project: session.project, repo: session.repo, prId: session.prId, items,
          };
          await streamCommentPreview(previewSession);
          return;
        }

        const exactFinding = resolveByNumber(prompt, session.findings);
        let finding: ReviewFinding | undefined;

        if (exactFinding) {
          finding = exactFinding;
        } else {
          const matchPrompt =
            `The developer asked: "${prompt}"\n\n` +
            `Available findings:\n${session.findings.map((f) => `#${f.id}: [${f.severity}] ${f.title} (${f.file})`).join('\n')}\n\n` +
            `Reply with ONLY the finding number (e.g. "2") that best matches the question, or "none" if no match.`;
          const matchRaw = await callLLMWithProgress(matchPrompt, request.model, token, 'Matching finding');
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

        const answer = await callLLMWithProgress(followUpPrompt, request.model, token, 'Explaining finding');
        stream.markdown(`**Finding #${finding.id} — ${finding.title}**\n\n${answer}\n\n<!-- bitbucket:review-session -->`);
        return;
      }
    }

    // 3. New review
    if (!prUrlMatch) {
      stream.markdown(
        'Point me at a PR to review:\n\n' +
        '`@bitbucket https://bitbucket.company.com/projects/PROJ/repos/myrepo/pull-requests/42`\n\n' +
        'Or run `@bitbucket check` to verify your connection.',
      );
      return;
    }

    const isConfigured = config.authType === 'cloud'
      ? !!config.token
      : !!(config.baseUrl && config.token);
    if (!isConfigured) {
      stream.markdown(
        '**Bitbucket not configured.**\n\nRun **Ticket Sidekick: Set Bitbucket Personal Access Token** or **Ticket Sidekick: Configure Bitbucket Cloud Credentials** first.',
      );
      return;
    }

    const parsed = parsePrUrl(prUrlMatch[0]);
    if (!parsed) {
      stream.markdown(`Could not parse PR URL: \`${prUrlMatch[0]}\``);
      return;
    }

    const client = new BitbucketApiClient({
      baseUrl: config.baseUrl ?? '',
      authType: config.authType,
      token: config.token!,
    });
    const service = new PrReviewService(client);

    try {
      // Detect quick/deep mode keyword from prompt (overrides setting)
      const promptWithoutUrl = prompt.replace(/https?:\/\/\S+/g, '').toLowerCase();
      const reviewMode = /\bquick\b/.test(promptWithoutUrl) ? 'quick'
        : /\bdeep\b/.test(promptWithoutUrl) ? 'standard'
        : (config.reviewMode ?? 'standard');

      // Resolve token budget: user setting → model API → safe fallback
      const resolvedContextTokens = config.modelContextTokens
        ?? (request.model as unknown as { maxInputTokens?: number }).maxInputTokens
        ?? 60000;
      const budgetRatio = config.contextBudgetRatio ?? 0.7;
      const tokenBudget = Math.floor(resolvedContextTokens * budgetRatio);

      stream.markdown('_Fetching PR…_\n\n');
      const pr = await client.getPullRequest(parsed.project, parsed.repo, parsed.prId);
      const rawDiff = await client.getPullRequestDiff(parsed.project, parsed.repo, parsed.prId);

      // Apply exclusion patterns before chunking
      let fileDiffs = parseDiff(rawDiff);
      const excludePatterns = config.reviewExcludePatterns ?? [];
      let excludedCount = 0;
      if (excludePatterns.length > 0) {
        const before = fileDiffs.length;
        fileDiffs = fileDiffs.filter(
          (d) => !excludePatterns.some((p) => minimatch(d.path, p, { matchBase: true })),
        );
        excludedCount = before - fileDiffs.length;
      }

      if (fileDiffs.length === 0) {
        stream.markdown('_No files to review after applying exclusion patterns._\n\n');
        return;
      }

      if (excludedCount > 0) {
        stream.markdown(`_${excludedCount} file${excludedCount !== 1 ? 's' : ''} excluded by pattern._\n\n`);
      }

      const chunks = buildAdaptiveChunks(fileDiffs, tokenBudget);

      let allFindings: Array<Omit<ReviewFinding, 'id'>> = [];
      let fileOffset = 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const from = fileOffset + 1;
        const to = fileOffset + chunk.length;
        fileOffset += chunk.length;
        const batchLabel = chunks.length > 1 ? ` · batch ${i + 1}/${chunks.length}` : '';
        stream.markdown(`_Analysing files ${from}–${to} of ${fileDiffs.length}${batchLabel}…_\n\n`);

        const batchStatus = chunks.length > 1 ? `Batch ${i + 1}/${chunks.length}` : 'Analysing';
        const chunkRaw = await callLLMWithProgress(
          service.buildPrompt(pr, chunk, undefined, config.reviewInstructions),
          request.model, token, batchStatus,
        );
        const { findings, additionalFilesNeeded } = await parseReviewResponse(chunkRaw);
        let chunkFindings = annotateWithLineTypes(findings, chunk);

        if (reviewMode !== 'quick' && additionalFilesNeeded.length > 0) {
          const capped = additionalFilesNeeded.slice(0, 5);
          const batchSuffix = chunks.length > 1 ? ` (batch ${i + 1})` : '';
          stream.markdown(`_Fetching ${capped.length} context file${capped.length !== 1 ? 's' : ''}${batchSuffix}…_\n\n`);
          const extraContents = await service.gatherFileContents(
            parsed.project, parsed.repo, pr.fromCommitHash,
            capped,
            makeWorkspaceReader,
          );
          const pass2Raw = await callLLMWithProgress(
            service.buildPrompt(pr, chunk, extraContents, config.reviewInstructions),
            request.model, token, `${batchStatus} pass 2`,
          );
          chunkFindings = annotateWithLineTypes((await parseReviewResponse(pass2Raw)).findings, chunk);
        }

        allFindings = allFindings.concat(chunkFindings);

        if (chunks.length > 1 && i < chunks.length - 1) {
          const crit = chunkFindings.filter((f) => f.severity === 'critical').length;
          const warn = chunkFindings.filter((f) => f.severity === 'warning').length;
          const sugg = chunkFindings.filter((f) => f.severity === 'suggestion').length;
          const tally = [
            crit ? `${crit} 🔴` : '',
            warn ? `${warn} 🟡` : '',
            sugg ? `${sugg} 🔵` : '',
          ].filter(Boolean).join(' · ') || 'no issues';
          stream.markdown(`_Batch ${i + 1}/${chunks.length} done · ${tally}_\n\n`);
        }
      }

      const numbered = allFindings.map((f, idx) => ({ ...f, id: idx + 1 }));
      const output = service.formatReview(numbered, pr, fileDiffs.length);
      stream.markdown(output);

      await ws.update('bitbucket.session.review', {
        prTitle: pr.title,
        prUrl: prUrlMatch[0],
        project: parsed.project,
        repo: parsed.repo,
        prId: parsed.prId,
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
