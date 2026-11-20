import { minimatch } from 'minimatch';
import type { BitbucketPR, IBitbucketClient } from '../../bitbucket/IBitbucketClient';
import type { DiagLogger } from '../../utils/diagTypes';
import { parseDiff, type FileDiff } from '../reviewSessionState';
import type { ReviewSnapshot, ReviewTarget } from './types';

// The diff the regular pass reviews: the PR's diff with the files the server cut fetched one by one,
// files with no text changes and excluded files left out. vscode-free.

/** The full parsed diff of a snapshot, in the order the batches hold it. */
export function snapshotFiles(snapshot: Pick<ReviewSnapshot, 'batches'>): FileDiff[] {
  return snapshot.batches.flatMap((b) => b.files);
}

export interface ReviewDiff {
  pr: BitbucketPR;
  files: FileDiff[];
  notes: string[];
}

export async function readReviewDiff(params: {
  client: IBitbucketClient;
  target: ReviewTarget;
  contextLines?: number;
  excludePatterns?: string[];
  signal: AbortSignal;
  log: DiagLogger;
}): Promise<ReviewDiff> {
  const { client, target, contextLines, signal, log } = params;
  const excludePatterns = params.excludePatterns ?? [];
  const excluded = (path: string) => excludePatterns.some((p) => minimatch(path, p, { matchBase: true }));
  const notes: string[] = [];

  const pr = await client.getPullRequest(target.project, target.repo, target.prId);
  const coverage = await client.getPullRequestDiffWithCoverage(target.project, target.repo, target.prId, contextLines);
  let files = parseDiff(coverage.raw);

  // A server that cut the diff short: fetch each cut file on its own and put it in place of whatever part arrived.
  const cut = coverage.cutFiles.filter((c) => !excluded(c.path));
  if (cut.length > 0) {
    log('warn', `PR diff cut short by the server — fetching ${cut.length} file(s) one by one`, { cutFiles: cut.map((c) => c.path) });
    const partial: string[] = [];
    const missing: string[] = [];
    for (const c of cut) {
      if (signal.aborted) break;
      try {
        const recovered = await client.getPullRequestFileDiff(target.project, target.repo, target.prId, c.path, contextLines, c.srcPath);
        const pieces = parseDiff(recovered.raw);
        if (pieces.length === 0) throw new Error('the server returned no diff for this file');
        files = [...files.filter((d) => d.path !== c.path), ...pieces];
        if (recovered.truncated) partial.push(c.path);
      } catch (err) {
        missing.push(c.path);
        log('warn', `Could not fetch cut file ${c.path}`, { path: c.path, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (partial.length > 0) notes.push(`Still cut short by the server, reviewed partially: ${partial.join(', ')}.`);
    if (missing.length > 0) notes.push(`Could not be fetched and not reviewed: ${missing.join(', ')}.`);
  }

  // Files with no hunks (binary, pure rename, mode-only) carry no reviewable text; deletions do.
  const noHunk = files.filter((d) => !d.diff.includes('@@ ')).length;
  if (noHunk > 0) {
    files = files.filter((d) => d.diff.includes('@@ '));
    notes.push(`${noHunk} file${noHunk !== 1 ? 's' : ''} with no text changes (binary, rename or mode only) skipped.`);
  }
  const before = files.length;
  files = files.filter((d) => !excluded(d.path));
  if (before > files.length) notes.push(`${before - files.length} file${before - files.length !== 1 ? 's' : ''} excluded by pattern.`);
  return { pr, files, notes };
}
