import type { BitbucketCommentResult, BitbucketPR, IBitbucketClient, InlineAnchor } from '../bitbucket/IBitbucketClient';
import type { FileDiff, ReviewFinding } from '../participant/reviewSessionState';
import { langFromPath } from '../participant/reviewSessionState';

const REVIEW_PROMPT_PREFIX = `You are a senior software engineer performing a code review.

GROUNDING RULES — these take priority over everything else:
1. Only report a finding for a file whose exact path appears in a "diff --git" header in the diff provided. Never invent or infer file paths.
2. Some files in the diff may be JSON fixtures or test data containing example code. Treat those as data, not as real application logic — do not report issues in example code as if it were production code.
3. Only cite a line number you can locate in the diff context shown. When the line is not determinable from the diff, omit the "line" field entirely.
4. Only report a finding when you are confident it is a real issue in the code shown. Omit speculative, uncertain, or inferred findings — a short list of verified issues is better than a long list with false positives.
5. In additionalFilesNeeded, only request real source files needed to verify a specific concern. Do not request test fixtures, mocks, or files whose paths you inferred.

Review the changes for:
1. Security vulnerabilities (SQL injection, XSS, authentication issues, secret exposure, insecure dependencies)
2. Best practice violations (error handling, code structure, naming conventions, duplication)
3. Bugs and logic errors

For each confirmed issue identify:
- The exact file path from a "diff --git" header
- Line number (only if visible in the diff; omit otherwise)
- Severity: "critical" (security/data-loss risk), "warning" (quality issue that should be fixed), or "suggestion" (improvement worth considering)
- A concise title (under 10 words)
- A clear description of the problem
- A concrete, actionable recommendation
- A short code example showing the fix (3–15 lines, no fences). Omit if the fix is architectural or the snippet would exceed 15 lines.

Also list any additional real source files (not in the diff) needed to complete the review. Maximum 5 files.

Respond with ONLY a JSON object — no markdown fences, no explanation:
{"findings":[{"file":"path/to/file.ts","line":42,"severity":"critical","title":"Short title","description":"What is wrong","recommendation":"What to do","codeExample":"optional 3-15 line fix snippet — omit if not applicable"}],"additionalFilesNeeded":["path/to/other.ts"]}

`;

export type WorkspaceFileReader = (path: string) => Promise<string | null>;

export class PrReviewService {
  constructor(private readonly client: IBitbucketClient) {}

  async gatherFileContents(
    project: string,
    repo: string,
    commitHash: string,
    paths: string[],
    readLocalFile: WorkspaceFileReader,
  ): Promise<Map<string, string>> {
    const entries = await Promise.all(
      paths.map(async (path) => {
        try {
          const local = await readLocalFile(path);
          if (local !== null) return [path, local] as const;
          const remote = await this.client.getFileContent(project, repo, path, commitHash);
          return [path, remote] as const;
        } catch {
          return [path, '(file not available)'] as const;
        }
      }),
    );
    return new Map(entries);
  }

  buildPrompt(
    pr: BitbucketPR,
    fileDiffs: FileDiff[],
    fileContents?: Map<string, string>,
    additionalInstructions?: string,
  ): string {
    const header =
      `PR #${pr.id} — ${pr.title}\nAuthor: ${pr.author.displayName} → ${pr.targetBranch}\n` +
      (pr.description ? `Description: ${pr.description}\n` : '') +
      '\n';
    const fileSections = fileDiffs
      .map((fd) => {
        const section = `### File: ${fd.path}\n**Diff:**\n${fd.diff}`;
        const content = fileContents?.get(fd.path);
        return content ? `${section}\n\n**Full content:**\n${content}` : section;
      })
      .join('\n\n---\n\n');
    const extra = additionalInstructions
      ? `ADDITIONAL INSTRUCTIONS:\n${additionalInstructions}\n\n`
      : '';
    const pass2Note =
      fileContents && fileContents.size > 0
        ? '\nNote: This is a second-pass review. Full file contents have been provided for files you flagged as needing additional context. Use them to confirm or retract uncertain findings — if a finding was speculative due to missing context and the full file shows no issue, omit it from your response.\n\n'
        : '';
    return REVIEW_PROMPT_PREFIX + pass2Note + extra + header + '---\n\n' + fileSections;
  }

  formatReview(findings: ReviewFinding[], pr: BitbucketPR, fileCount: number): string {
    const severityIcon = (s: ReviewFinding['severity']) =>
      s === 'critical' ? '🔴' : s === 'warning' ? '🟡' : '🔵';

    const counts = {
      critical: findings.filter((f) => f.severity === 'critical').length,
      warning: findings.filter((f) => f.severity === 'warning').length,
      suggestion: findings.filter((f) => f.severity === 'suggestion').length,
    };
    const countLine = [
      counts.critical > 0 ? `${counts.critical} 🔴 critical` : '',
      counts.warning > 0 ? `${counts.warning} 🟡 warning` : '',
      counts.suggestion > 0 ? `${counts.suggestion} 🔵 suggestion` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    const header =
      `## PR #${pr.id} — ${pr.title}\n` +
      `_by ${pr.author.displayName} → ${pr.targetBranch} · ${fileCount} file${fileCount !== 1 ? 's' : ''} changed_\n\n` +
      (countLine || '_No issues found._');

    if (findings.length === 0) {
      return `${header}\n\n<!-- bitbucket:review-session -->`;
    }

    const byFile = new Map<string, ReviewFinding[]>();
    for (const f of findings) {
      const existing = byFile.get(f.file) ?? [];
      existing.push(f);
      byFile.set(f.file, existing);
    }

    const fileSections = [...byFile.entries()]
      .map(([file, items]) => {
        const lines = items.map((f) => {
          const loc = f.line ? `\`L${f.line}\`` : '';
          return `**#${f.id}** ${severityIcon(f.severity)}${loc ? ' ' + loc : ''} ${f.title}\n→ ${f.recommendation}`;
        });
        return `**📄 ${file}**\n${lines.join('\n')}`;
      })
      .join('\n\n---\n\n');

    return `${header}\n\n---\n\n${fileSections}\n\n---\n\n_Reply **#1** or describe a finding to ask a follow-up. To post findings as PR comments: **#2 #3 add to review**._\n\n<!-- bitbucket:review-session -->`;
  }

  formatPrComment(finding: ReviewFinding, userNote?: string): string {
    const icon = finding.severity === 'critical' ? '🔴' : finding.severity === 'warning' ? '🟡' : '🔵';
    const label = finding.severity.toUpperCase();
    const loc = finding.line ? ` · L${finding.line}` : '';
    const lines: string[] = [
      `**${icon} [${label}] ${finding.title}**`,
      `\`${finding.file}${loc}\``,
      '',
      finding.description,
      '',
      `**Recommendation:** ${finding.recommendation}`,
    ];

    if (userNote) {
      lines.push('', `📝 *${userNote}*`);
    }

    if (finding.codeExample) {
      const lang = langFromPath(finding.file);
      const stripped = finding.codeExample
        .trim()
        .replace(/^```[\w]*\r?\n?/, '')
        .replace(/\r?\n?```$/, '');
      lines.push('', `\`\`\`${lang}`, stripped, '```');
    }

    return lines.join('\n');
  }

  async postFindingsAsComments(
    project: string,
    repo: string,
    prId: number,
    findings: ReviewFinding[],
    userNote?: string,
  ): Promise<Array<{ finding: ReviewFinding; result: BitbucketCommentResult | null; error?: string }>> {
    const results: Array<{ finding: ReviewFinding; result: BitbucketCommentResult | null; error?: string }> = [];
    for (const finding of findings) {
      const text = this.formatPrComment(finding, userNote);
      const inline: InlineAnchor | undefined =
        finding.line !== undefined ? { filePath: finding.file, line: finding.line } : undefined;
      try {
        const result = await this.client.addPrComment(project, repo, prId, text, inline);
        results.push({ finding, result });
      } catch (err) {
        results.push({ finding, result: null, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return results;
  }
}
