import { describe, it, expect } from 'vitest';
import {
  isUsageRequest,
  buildBitbucketNotConfiguredMessage,
  buildChatCommandLink,
  neutralizeMarkdownLinks,
  composeReviewOutput,
  computeBitbucketFollowups,
  isEndSessionRequest,
  isReviewStartWithoutUrl,
  endBitbucketSessions,
  BITBUCKET_SESSION_KEYS,
  parseSmartFallbackReply,
  ALL_PERSONA_IDS,
  formatReviewForSharing,
  type BitbucketFollowupState,
  type ReviewFinding,
  type ReviewSession,
} from '../participant/reviewSessionState';
import { isGreetingOrEmpty } from '../participant/sessionState';

describe('buildBitbucketNotConfiguredMessage', () => {
  it('names the base URL setting for Data Center when baseUrl is missing', () => {
    const message = buildBitbucketNotConfiguredMessage({ authType: 'datacenter', baseUrl: undefined, token: undefined });

    expect(message).toContain('ticketSidekick.bitbucket.baseUrl');
  });

  it('names the Data Center PAT setup command when baseUrl is set but the token is missing', () => {
    const message = buildBitbucketNotConfiguredMessage({ authType: 'datacenter', baseUrl: 'https://bitbucket.example.com', token: undefined });

    expect(message).toContain('Ticket Sidekick: Set Bitbucket Personal Access Token');
  });

  it('names the Cloud credentials setup command for Cloud with no token — baseUrl is never mentioned', () => {
    const message = buildBitbucketNotConfiguredMessage({ authType: 'cloud', baseUrl: undefined, token: undefined });

    expect(message).toContain('Ticket Sidekick: Configure Bitbucket Cloud Credentials');
    expect(message).not.toContain('baseUrl');
  });

  it('never emits a trusted MarkdownString command link — plain text only', () => {
    const message = buildBitbucketNotConfiguredMessage({ authType: 'datacenter', baseUrl: undefined, token: undefined });

    expect(message).not.toContain('(command:');
  });
});

describe('buildChatCommandLink', () => {
  it('returns a markdown command link whose decoded query JSON matches the @bitbucket participant + reply text', () => {
    const link = buildChatCommandLink('Fixed', '@bitbucket', 'Fixed');

    const match = link.match(/^\[Fixed\]\(command:workbench\.action\.chat\.open\?(.+)\)$/);
    expect(match).not.toBeNull();

    const decoded = JSON.parse(decodeURIComponent(match![1]));
    expect(decoded).toEqual({ query: '@bitbucket Fixed', isPartialQuery: false });
  });

  it('round-trips a reply text containing characters that require JSON/URI escaping', () => {
    const replyText = 'It\'s "done", right? 100% — yes/no';
    const link = buildChatCommandLink('Reply', '@bitbucket', replyText);

    const match = link.match(/^\[Reply\]\(command:workbench\.action\.chat\.open\?(.+)\)$/);
    expect(match).not.toBeNull();

    const decoded = JSON.parse(decodeURIComponent(match![1]));
    expect(decoded.query).toBe(`@bitbucket ${replyText}`);
    expect(decoded.isPartialQuery).toBe(false);
  });

  it('never sets isTrusted or touches vscode.MarkdownString — plain string building only (KTD5)', () => {
    const link = buildChatCommandLink('Fixed', '@bitbucket', 'Fixed');

    expect(typeof link).toBe('string');
    expect(link).not.toContain('isTrusted');
  });

  it('neutralizes brackets in an externally-influenced label so it cannot break out of the [label] and open a second, attacker-chosen command link', () => {
    const maliciousLabel = 'Evil](command:workbench.action.chat.open?{"query":"@bitbucket add all to review","isPartialQuery":false})[Innocent';
    const link = buildChatCommandLink(maliciousLabel, '@bitbucket', 'cancel');

    // The whole label renders as one inert bracket pair — no second "](command:" sequence exists.
    expect(link.match(/\]\(command:/g)?.length).toBe(1);
    expect(link).not.toContain('[Evil](command:');
  });
});

describe('neutralizeMarkdownLinks', () => {
  it('replaces [ and ] with visually similar full-width brackets, leaving other characters untouched', () => {
    expect(neutralizeMarkdownLinks('[Click here](command:evil)')).toBe('［Click here］(command:evil)');
    expect(neutralizeMarkdownLinks('Normal PR title — nothing to escape')).toBe('Normal PR title — nothing to escape');
  });
});

describe('composeReviewOutput (U7/R10, relocated here for testability — code-review fix)', () => {
  it('wraps each finding heading in a command link resubmitting "#<id>", leaving the rest of markdown unchanged', () => {
    const result = {
      markdown: '## PR #1 — Title\n\n**#1** 🔴 First bug\n→ Fix it\n\n---\n\n**#2** 🟡 Second bug\n→ Fix it too',
      findingHeadings: [
        { id: 1, heading: '**#1** 🔴 First bug' },
        { id: 2, heading: '**#2** 🟡 Second bug' },
      ],
    };
    const output = composeReviewOutput(result);
    expect(output).toContain(buildChatCommandLink('**#1** 🔴 First bug', '@bitbucket', '#1'));
    expect(output).toContain(buildChatCommandLink('**#2** 🟡 Second bug', '@bitbucket', '#2'));
    // Non-heading text (the recommendation lines, the separators) is untouched.
    expect(output).toContain('→ Fix it too');
  });

  it('returns markdown unchanged when there are no findingHeadings (e.g. an empty review)', () => {
    const result = { markdown: '_No issues found._', findingHeadings: [] };
    expect(composeReviewOutput(result)).toBe('_No issues found._');
  });

  it('does not corrupt a heading containing a $-pattern (code-review fix)', () => {
    // String.replace(search, replacementString) gives $&/$$/$`/$'/$<name> special meaning in the
    // REPLACEMENT argument. buildChatCommandLink(heading, ...) embeds `heading` itself inside the
    // string it returns, so a heading containing one of these sequences used to corrupt the row
    // once that returned string became the replacement. A replacer function must treat it as a
    // literal string regardless of content.
    const heading = '**#1** 🔴 Cost is $& per unit';
    const result = {
      markdown: `## PR #1 — Title\n\n${heading}\n→ Fix it`,
      findingHeadings: [{ id: 1, heading }],
    };
    const output = composeReviewOutput(result);
    expect(output).toContain(buildChatCommandLink(heading, '@bitbucket', '#1'));
    expect(output).not.toContain('**#1** 🔴 Cost is **#1** 🔴 Cost is $& per unit per unit');
  });
});

describe('computeBitbucketFollowups', () => {
  it('returns example prompts for a greeting, capped at 3', () => {
    const state: BitbucketFollowupState = { kind: 'greeting' };

    const chips = computeBitbucketFollowups(state);

    expect(chips.length).toBeGreaterThan(0);
    expect(chips.length).toBeLessThanOrEqual(3);
  });

  it('returns "add findings to review"/"explain finding #1"-shaped chips after a completed review', () => {
    const state: BitbucketFollowupState = { kind: 'reviewCompleted', findingCount: 3 };

    const chips = computeBitbucketFollowups(state);

    expect(chips.length).toBeGreaterThan(0);
    expect(chips.length).toBeLessThanOrEqual(3);
    expect(chips.some((c) => /add.*findings?.*review/i.test(c.prompt) || /add.*findings?.*review/i.test(c.label ?? ''))).toBe(true);
    expect(chips.some((c) => /explain/i.test(c.prompt) || /explain/i.test(c.label ?? ''))).toBe(true);
  });

  it('offers "Copy for Teams" as the third chip after a review with findings', () => {
    const chips = computeBitbucketFollowups({ kind: 'reviewCompleted', findingCount: 3 });

    expect(chips).toHaveLength(3);
    expect(chips[2]).toEqual({ prompt: 'copy for teams', label: 'Copy for Teams' });
  });

  it('offers only "Copy for Teams" when the review found nothing (R10: no "ask a question" replacement)', () => {
    const state: BitbucketFollowupState = { kind: 'reviewCompleted', findingCount: 0 };

    const chips = computeBitbucketFollowups(state);

    expect(chips).toEqual([{ prompt: 'copy for teams', label: 'Copy for Teams' }]);
  });

  it('returns no chips when there is no prior operation state', () => {
    expect(computeBitbucketFollowups({ kind: 'none' })).toEqual([]);
  });
});

describe('end-session chips (Done / Post it / Cancel)', () => {
  const done = { prompt: 'done', label: 'Done' };

  it('appends Done after the three action chips of a finished review', () => {
    const chips = computeBitbucketFollowups({ kind: 'reviewCompleted', findingCount: 3 }, ['review-session']);

    expect(chips.map((c) => c.label)).toEqual(['Add findings to review', 'Explain finding #1', 'Copy for Teams', 'Done']);
    expect(chips[3]).toEqual(done);
  });

  it('offers Copy for Teams then Done after a review with no findings', () => {
    const chips = computeBitbucketFollowups({ kind: 'reviewCompleted', findingCount: 0 }, ['review-session']);

    expect(chips).toEqual([{ prompt: 'copy for teams', label: 'Copy for Teams' }, done]);
  });

  it('offers only Done for a follow-up answer that carries no action state', () => {
    expect(computeBitbucketFollowups({ kind: 'none' }, ['review-session'])).toEqual([done]);
  });

  it('offers Post it and Cancel for a comment preview', () => {
    expect(computeBitbucketFollowups({ kind: 'none' }, ['comment-preview'])).toEqual([
      { prompt: 'post it', label: 'Post it' },
      { prompt: 'cancel', label: 'Cancel' },
    ]);
  });

  it('offers Cancel for the smart-fallback question', () => {
    expect(computeBitbucketFollowups({ kind: 'none' }, ['smart-fallback-session'])).toEqual([
      { prompt: 'cancel', label: 'Cancel' },
    ]);
  });

  it('offers no chips without a state and without a session', () => {
    expect(computeBitbucketFollowups({ kind: 'none' }, [])).toEqual([]);
    expect(computeBitbucketFollowups({ kind: 'none' }, undefined)).toEqual([]);
  });
});

describe('isEndSessionRequest', () => {
  it('accepts done in any case and the existing cancel words', () => {
    for (const word of ['done', 'Done', ' DONE ', 'cancel', 'c', 'stop']) {
      expect(isEndSessionRequest(word)).toBe(true);
    }
  });

  it('does not treat a question that mentions done as an end request', () => {
    expect(isEndSessionRequest('done with the security findings?')).toBe(false);
    expect(isEndSessionRequest('explain #2')).toBe(false);
  });
});

describe('isReviewStartWithoutUrl', () => {
  it('is true for the review command with no URL and for a bare mode word', () => {
    expect(isReviewStartWithoutUrl('', 'review')).toBe(true);
    expect(isReviewStartWithoutUrl('focus on security', 'review')).toBe(true);
    for (const word of ['smart', 'Quick', ' deep ']) {
      expect(isReviewStartWithoutUrl(word, undefined)).toBe(true);
    }
  });

  it('is false for a question that merely contains a mode word', () => {
    expect(isReviewStartWithoutUrl('is this quick to fix?', undefined)).toBe(false);
    expect(isReviewStartWithoutUrl('explain #2', undefined)).toBe(false);
  });

  it('is false when a PR URL is present or nothing was asked', () => {
    const url = 'https://bb.example.com/projects/P/repos/r/pull-requests/1';
    expect(isReviewStartWithoutUrl(`smart ${url}`, undefined)).toBe(false);
    expect(isReviewStartWithoutUrl(url, 'review')).toBe(false);
    expect(isReviewStartWithoutUrl('', undefined)).toBe(false);
  });
});

describe('endBitbucketSessions', () => {
  it('clears the three Bitbucket session keys and leaves other keys alone', async () => {
    const store = new Map<string, unknown>([
      ['bitbucket.session.review', { x: 1 }],
      ['bitbucket.session.commentPreview', { x: 2 }],
      ['bitbucket.session.smartFallback', { x: 3 }],
      ['jira.session.creating', { keep: true }],
    ]);

    await endBitbucketSessions({ update: async (key, value) => { store.set(key, value); } });

    for (const key of BITBUCKET_SESSION_KEYS) expect(store.get(key)).toBeUndefined();
    expect(store.get('jira.session.creating')).toEqual({ keep: true });
  });
});

describe('isGreetingOrEmpty (shared with @jira — re-verified from the @bitbucket call site)', () => {
  it('detects a bare greeting and an empty prompt', () => {
    expect(isGreetingOrEmpty('hi')).toBe(true);
    expect(isGreetingOrEmpty('')).toBe(true);
  });

  it('does not classify a PR URL prompt as a greeting', () => {
    expect(isGreetingOrEmpty('https://bitbucket.company.com/projects/PROJ/repos/myrepo/pull-requests/42')).toBe(false);
  });
});

describe('parseSmartFallbackReply (U4/R7)', () => {
  it('resolves "all" to the full four-persona set', () => {
    const choice = parseSmartFallbackReply('all');

    expect(choice.kind).toBe('all');
    expect(choice.personas).toEqual(ALL_PERSONA_IDS);
    expect(choice.personas).toHaveLength(4);
  });

  it('resolves "standard" to an empty persona set', () => {
    const choice = parseSmartFallbackReply('standard');

    expect(choice.kind).toBe('standard');
    expect(choice.personas).toEqual([]);
  });

  it('is case/whitespace-insensitive and tolerates surrounding words', () => {
    expect(parseSmartFallbackReply('  ALL please  ').kind).toBe('all');
    expect(parseSmartFallbackReply('go standard').kind).toBe('standard');
  });

  it('classifies an unrecognized reply as unrecognized rather than defaulting', () => {
    const choice = parseSmartFallbackReply('maybe later');

    expect(choice.kind).toBe('unrecognized');
    expect(choice.kind).not.toBe('all');
    expect(choice.kind).not.toBe('standard');
  });
});

describe('formatReviewForSharing (Copy for Teams)', () => {
  const PR_URL = 'https://bb.example.com/projects/PROJ/repos/app/pull-requests/42';

  function finding(id: number, severity: ReviewFinding['severity'], extra: Partial<ReviewFinding> = {}): ReviewFinding {
    return {
      id,
      file: `src/file${id}.ts`,
      line: 10 * id,
      severity,
      title: `Title ${id}`,
      description: `Description ${id}`,
      recommendation: `Recommendation ${id}`,
      confidence: 0.9,
      ...extra,
    };
  }

  function session(findings: ReviewFinding[], extra: Partial<ReviewSession> = {}): ReviewSession {
    return {
      prTitle: 'Fix login race',
      prUrl: PR_URL,
      project: 'PROJ',
      repo: 'app',
      prId: 42,
      findings,
      prAuthor: 'Jane Doe',
      prTargetBranch: 'main',
      ...extra,
    };
  }

  it('groups a whole review by severity under a header with the bare PR link', () => {
    const findings = [
      finding(1, 'warning'), finding(2, 'critical'), finding(3, 'warning'),
      finding(4, 'critical'), finding(5, 'warning'),
    ];

    const { text, copiedCount, totalCount } = formatReviewForSharing(session(findings));

    expect(copiedCount).toBe(5);
    expect(totalCount).toBe(5);
    const lines = text.split('\n');
    expect(lines[0]).toBe('PR #42 — Fix login race');
    expect(lines[1]).toBe('by Jane Doe → main · 5 findings');
    expect(lines[2]).toBe(PR_URL);
    expect(text).toContain('🔴 Critical (2)');
    expect(text).toContain('🟡 Warning (3)');
    expect(text).not.toContain('Suggestion');
    expect(text.indexOf('Critical (2)')).toBeLessThan(text.indexOf('Warning (3)'));
    expect(text).toContain('#2 🔴 src/file2.ts:L20 — Title 2');
    expect(text).toContain('Recommendation: Recommendation 2');
  });

  it('copies only the selected findings and says how many of the whole review they are', () => {
    const findings = [1, 2, 3, 4, 5, 6, 7].map((id) => finding(id, id === 1 ? 'critical' : 'suggestion'));

    const { text, copiedCount, totalCount } = formatReviewForSharing(session(findings), { targets: [3, 1] });

    expect(copiedCount).toBe(2);
    expect(totalCount).toBe(7);
    expect(text).toContain('2 of 7 findings');
    expect(text).toContain('🔴 Critical (1)');
    expect(text).toContain('🔵 Suggestion (1)');
    expect(text).toContain('Title 1');
    expect(text).toContain('Title 3');
    expect(text).not.toContain('Title 2');
  });

  it('marks a finding whose location could not be verified instead of showing a line', () => {
    const findings = [finding(1, 'warning', { line: undefined, locationUnverified: true })];

    const { text } = formatReviewForSharing(session(findings));

    expect(text).toContain('#1 🟡 src/file1.ts (location unverified) — Title 1');
    expect(text).not.toContain(':L');
  });

  it('marks findings below the confidence threshold, and only those', () => {
    const findings = [
      finding(1, 'warning', { confidence: 0.4 }),
      finding(2, 'warning', { confidence: 0.7 }),
      finding(3, 'warning', { confidence: undefined }),
    ];

    const { text } = formatReviewForSharing(session(findings), { confidenceThreshold: 0.7 });

    const block = (id: number) => text.split('\n\n').find((b) => b.startsWith(`#${id} `)) ?? '';
    expect(block(1)).toContain('(low confidence)');
    expect(block(2)).not.toContain('low confidence');
    expect(block(3)).not.toContain('low confidence');
  });

  it('shares a review without findings as the header plus "No issues found"', () => {
    const { text, copiedCount } = formatReviewForSharing(session([]));

    expect(copiedCount).toBe(0);
    expect(text).toContain('0 findings');
    expect(text).toContain('No issues found.');
    expect(text).not.toMatch(/Critical|Warning|Suggestion/);
  });

  it('adds no chat markup of its own and copies finding text verbatim', () => {
    const findings = [finding(1, 'critical', {
      title: 'Guard arr[i] | null access',
      recommendation: 'Use `escape()`\n\nthen   retry\u0007',
    })];

    const { text } = formatReviewForSharing(session(findings, { prTitle: 'Handle [draft] PRs' }));

    // No table rows, bold headings, command links, or the chat renderer's fullwidth brackets.
    expect(text).not.toMatch(/^\|/m);
    expect(text).not.toContain('**');
    expect(text).not.toContain('command:');
    expect(text).not.toContain('［');
    expect(text).not.toContain('\u0007');
    expect(text).toContain('PR #42 — Handle [draft] PRs');
    expect(text).toContain('— Guard arr[i] | null access');
    expect(text).toContain('Recommendation: Use `escape()` then retry');
  });

  it('keeps a multi-line recommendation on one line so each finding stays one block', () => {
    const findings = [finding(1, 'warning', { recommendation: 'First line.\r\nSecond line.' })];

    const { text } = formatReviewForSharing(session(findings));

    expect(text).toContain('Recommendation: First line. Second line.');
  });

  it('omits the author line for a session saved before author and branch were stored', () => {
    const { text } = formatReviewForSharing(session([finding(1, 'warning')], { prAuthor: undefined, prTargetBranch: undefined }));

    const lines = text.split('\n');
    expect(lines[0]).toBe('PR #42 — Fix login race');
    expect(lines[1]).toBe('1 finding');
    expect(text).not.toContain('by ');
  });

  it('lists higher-confidence findings first within a group, and findings without confidence last', () => {
    const findings = [
      finding(1, 'warning', { confidence: undefined }),
      finding(2, 'warning', { confidence: 0.5 }),
      finding(3, 'warning', { confidence: 0.95 }),
    ];

    const { text } = formatReviewForSharing(session(findings));

    const order = [3, 2, 1].map((id) => text.indexOf(`#${id} `));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe('isUsageRequest', () => {
  it('recognises the bare word, in any case and with surrounding whitespace', () => {
    expect(isUsageRequest('usage')).toBe(true);
    expect(isUsageRequest('  Usage ')).toBe(true);
  });

  it('is false for anything else, including a sentence that mentions usage', () => {
    expect(isUsageRequest('show usage')).toBe(false);
    expect(isUsageRequest('usage of retries?')).toBe(false);
    expect(isUsageRequest('')).toBe(false);
  });

  it('is false when the message carries a PR URL, so a review always wins', () => {
    expect(isUsageRequest('usage https://bitbucket.example.com/projects/P/repos/r/pull-requests/4')).toBe(false);
  });
});
