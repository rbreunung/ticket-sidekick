---
title: A model-requested context file could read another repository through a ".." path
date: 2026-11-26
category: security-issues
module: "Bitbucket client path encoding (src/bitbucket/BitbucketApiClient.ts, repositoryUrlPath / encodePathSegments) and every caller that passes it a repository path: the review's context files (PrReviewService.gatherFileContents, src/review/engine/plumbing.ts readContextAtCommit) and the bitbucket_read_file tool"
problem_type: security_issue
component: assistant
symptoms:
  - "A context file path the review model asked for in additionalFilesNeeded went to BitbucketApiClient.getFileContent unchecked"
  - "encodeURIComponent leaves a '.' or '..' segment unchanged, and URL parsing then resolves it: projects/P/repos/R/browse/../../../../OTHER/repos/secrets/browse/creds.txt is requested as projects/OTHER/repos/secrets/browse/creds.txt"
  - "Pull request text can steer which files the model asks for, so a PR could make the review read any repository the configured token can see and put its content into the model prompt (and from there into findings or posted comments)"
  - "No error, log line or test showed it: the request succeeded against a real repository"
root_cause: missing_validation
resolution_type: code_fix
severity: high
related_components: [service_layer]
tags: [bitbucket, path-traversal, url-encoding, untrusted-input, prompt-injection, review-context-files, security]
---

# A model-requested context file could read another repository through a ".." path

## Problem

The pull request review lets the model ask for whole files outside the diff (`additionalFilesNeeded` in its reply). Those paths went straight into a Bitbucket request URL. The client's encoding keeps `..` segments, so a path the model was steered into asking for could leave the pull request's repository and read another one the credentials can see. Fixed in [PR #150](https://github.com/rbreunung/ticket-sidekick/pulls) (branch `claude/fix-bitbucket-path-traversal`; open, unmerged as of this writing).

## Symptoms

- `encodePathSegments` in `src/bitbucket/BitbucketApiClient.ts` is `path.split('/').map(encodeURIComponent).join('/')`. `encodeURIComponent('..')` is `'..'`, so the segment reaches the URL as a real path step.
- `new URL('https://bb.example.com/rest/api/1.0/projects/P/repos/R/browse/../../../../OTHER/repos/secrets/browse/creds.txt?at=abc').href` gives `https://bb.example.com/rest/api/1.0/projects/OTHER/repos/secrets/browse/creds.txt?at=abc` (checked with Node in this session). `fetch` parses the URL the same way.
- The review sees nothing unusual: the other repository answers with a normal file, and the content lands in the *Context files* section of the next prompt.

## What Didn't Work

- **Checking only in the new agent tool.** `bitbucket_read_file` (added in PR #149) already refused `.`/`..` segments before any request, because its path comes from an agent. That check sat in the tool, so the review engine's own path into the same client method, older than the tool, kept the hole. Two of the three callers of `getFileContent` were unguarded. A code review of PR #149 even recorded "bitbucket_read_file encodes path segments, so %2e%2e cannot traverse" as reassurance; the literal `..` was the case that mattered, and the other callers were not looked at.
- **Relying on percent-encoding.** Encoding does stop `%2e%2e` (it becomes `%252e%252e`) and `\` (it becomes `%5C`), which is why encoding looked like protection. It does nothing for a plain `..`.
- **Returning the "(file not available)" placeholder for a refused path.** `gatherFileContents` turned every failed read into that placeholder. The engine then stores every returned path as a context path of the batch (`batchReview.ts`), and a later persona pass re-reads stored context paths with `readContextAtCommit` whenever they are not in its run cache (after a restart, for example). It treats any failed read as "the reviewed commit can no longer be read" and skips the whole pass (`runPersonaPass` in `src/review/engine/extraPass.ts`; the critic does the same). A refused path kept that way would let a pull request switch off the persona passes.

## Solution

One rule, enforced in the client so every caller gets it:

- `repositoryPathProblem(path)` in `src/bitbucket/IBitbucketClient.ts` returns why a path cannot name a file in the repository: empty, a backslash, absolute (`/…` or `C:`), a `.` or `..` segment, or an empty segment (`a//b`, a trailing `/`). `bitbucket_read_file` uses the same function for its message.
- `repositoryUrlPath(path)` in `BitbucketApiClient.ts` throws `UnsafePathError` for such a path and only then encodes it. `getFileContent` (Data Center and Cloud) and `getPullRequestFileDiff` (Data Center) build their URLs with it.
- `PrReviewService.gatherFileContents` catches `UnsafePathError`, logs it without the path's content, and leaves the path out of the returned map, so it is never shown to the model or stored as a context path.

```ts
// before
const encPath = encodePathSegments(path);
// after
const encPath = repositoryUrlPath(path); // throws UnsafePathError before any request
```

## Why This Works

The URL is where `..` becomes dangerous, and the client is the one place every repository path goes through on its way into a URL. A check there cannot be missed by a new caller, which is how the hole stayed open: the tool had its own check, the engine did not. Leaving a refused path out entirely, instead of returning a placeholder, keeps the refusal from turning into stored state that later fails a whole pass.

## Prevention

- The checks are tests in `src/test/BitbucketApiClient.test.ts` ("a path that leaves the repository is never requested"): each escaping shape is refused on Data Center and Cloud with no `fetch` call, the per-file diff refuses the same, and a review asking for an escaping context file still gets its other files with every request inside `/projects/PROJ/repos/repo/`.
- Treat every path a model names as untrusted input, like the pull request text that steered it. That covers `additionalFilesNeeded`, critic file requests and any future "read this file" request in a model reply.
- A new client method that puts a repository path into a URL builds it with `repositoryUrlPath`, never with `encodePathSegments` directly.
- When a check guards an untrusted input, put it where the input becomes dangerous (here, the URL), not at the caller that happened to raise the concern. List every caller of the guarded method when reviewing such a fix.

## Related

- `docs/solutions/security-issues/jira-native-wiki-trigger-neutralization-in-shared-markdown-converter.md`: the same lesson for Jira wiki markup. A sanitizer placed at one producer left the shared converter and the callers that bypass it open; the fix moved it to the chokepoint.
- `docs/solutions/security-issues/waltz-oss-report-markdown-injection-in-jira-wiki-converter.md`: a first fix that looked protective (backslash escaping) and was not, as percent-encoding looked here.
- `docs/review-process.md` "Pass 2 refines Pass 1": where the refused paths are described for the review pipeline.
