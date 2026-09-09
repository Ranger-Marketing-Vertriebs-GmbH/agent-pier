# Continue a session with another account

Use **Continue with another account** in the session header when you want to resume a conversation with another signed-in account. AgentPier supports Codex → Codex and Claude Code → Claude Code. Create and sign in to the target account under Accounts first.

Select the target account, then choose **Switch account & resume**, or queue the switch until the CLI is idle. Interrupting active work requires acknowledgment. Open the terminal if the CLI asks to approve hooks, trust the project, or sign in; closing the dialog does not cancel an in-progress switch.

The AgentPier session, native conversation ID, project directory, attachments, chat draft, delivery receipts and assigned hosts stay in place. Only this conversation's native files are copied into the target account's history. Claude's session-specific subagent files and rewind snapshots are included. Account credentials, account configuration, unrelated conversations and project files are not copied. The original history is retained.

If startup fails after switching, choose **Retry with current account**, or open **Reload & resume**. A server restart retains the failed operation for manual recovery. A queued switch retains its selected target and can be cancelled. Requests are idempotent; retrying an uncertain HTTP request does not restart twice.

A return to an earlier account is allowed when its stored conversation is unchanged or an older prefix of the current conversation. Divergent histories, links in history storage and a conversation already running in the target account are rejected. No histories are silently merged or overwritten with a different conversation.

The feature supports standalone local and managed CLI accounts. Pipeline, login, imported history-only and provider-connection sessions are excluded. OpenCode and cross-CLI transfers are not supported. Codex requires a complete portable JSONL rollout; paginated/nonportable history is rejected before the source process is stopped. Authentication and remaining quota are enforced by the native CLI; AgentPier does not automatically rotate accounts or replay a failed prompt.

Validation includes isolated account/HTTP/tmux lifecycle tests for both CLIs, failure recovery, a concurrent target-session regression, filesystem isolation tests and Chromium/WebKit browser tests. An offline smoke check with installed Codex 0.153.4 also verified reading the copied conversation under its unchanged UUID from a fresh account home. These checks do not make live model requests using real user accounts.

![Account selection in the session dialog](screenshots/session-account-switch.png)
