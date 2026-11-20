// The names of the Bitbucket tools the extension offers to Copilot. Kept apart from the catalog so
// that tool modules and the message text they build can name another tool without importing the
// catalog, which imports them.

export const GET_PULL_REQUEST_TOOL = 'bitbucket_getPullRequest';
export const GET_PULL_REQUEST_DIFF_TOOL = 'bitbucket_getPullRequestDiff';
export const POST_COMMENT_TOOL = 'bitbucket_postComment';
export const OPEN_REVIEW_TOOL = 'bitbucket_open_review';
export const READ_FINDINGS_TOOL = 'bitbucket_read_findings';
export const CHECK_CONNECTION_TOOL = 'bitbucket_check_connection';
export const TOKEN_USAGE_TOOL = 'bitbucket_token_usage';
