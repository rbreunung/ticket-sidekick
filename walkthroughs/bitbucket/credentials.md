Ticket Sidekick needs Bitbucket credentials to read pull requests and post review comments on your behalf. Credentials are stored in VS Code's encrypted Secret Storage — never in `settings.json`.

[Set Data Center Personal Access Token](command:ticket-sidekick.setBitbucketDataCenterToken)

[Configure Cloud Credentials](command:ticket-sidekick.configureBitbucketCloud)

Use the first command if you're on Bitbucket Data Center (a Personal Access Token). Use the second if you're on Bitbucket Cloud (your Bitbucket username plus an App Password from bitbucket.org → Personal settings → App passwords — not an Atlassian API token). This step completes automatically once credentials are saved.
