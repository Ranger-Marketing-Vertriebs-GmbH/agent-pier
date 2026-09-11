# Reload and resume

Use **Reload & resume** in a Codex, Claude Code or OpenCode session to restart its native CLI with refreshed integrations. This also makes newly installed AgentPier SSH tools available in an existing conversation.

AgentPier verifies the native conversation ID before stopping the CLI and resumes that exact conversation. The AgentPier session ID, working directory, account, attachments, saved chat draft and SSH assignments remain attached to the same session. A reload does not resend chat messages or start a fresh conversation. Login, shell, pipeline and imported historical sessions are excluded.

Choose **After the response** to wait until the CLI is confirmed idle. The queued action is visible and can be cancelled. If the CLI activity cannot be identified, it keeps waiting. Immediate reload during an active or unrecognized state requires acknowledgement that the current step will be interrupted. Saved conversation history survives; unfinished tool calls or remote work cannot be guaranteed to resume automatically. Check their outcome before asking the agent to repeat them.

If preflight validation fails, the existing CLI keeps running. If startup fails after the CLI has stopped, the session retains its verified conversation identity for a deliberate retry. Queued actions survive a web-service restart. Restored backups contain historical sessions, without queued reload actions or live tool capabilities.

The native CLI must still have access to its saved conversation files. AgentPier does not fall back to whichever conversation was most recent when the exact conversation cannot be resolved.

If the restarted CLI still needs verification, AgentPier opens the terminal automatically so you can allow hooks or trust the project. You can also choose **Open terminal** while the request is being submitted. Closing the dialog does not cancel the reload. Direct terminal input is available as soon as the replacement CLI is running. Chat delivery and model controls remain blocked until the exact resumed conversation is verified. Waiting for approval does not turn the reload into a failure after a fixed timeout. Previously failed replacements are checked again after a web-service restart and marked complete only when the running conversation and target account match.

Codex stores trust for each exact hook definition; use `/hooks` to review and trust hooks in the current account profile. AgentPier supplies stable hook commands with release paths taken from its launch environment, so ordinary AgentPier updates do not change those definitions. Existing users must approve the new definitions once. Changed definitions and different account profiles can still need approval. User and project hooks retain their own trust requirements; interactive sessions do not bypass hook trust. See the [official OpenAI hook documentation](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

## Model verification

Reload preflight checks the current model before stopping the CLI. If the CLI reports only a display name that cannot be resolved reliably, AgentPier rejects the reload instead of forcing an older model from the conversation history. This currently affects some OpenCode display names and unfamiliar native model labels. Changing the model immediately before reloading can also require a new response to confirm its exact identity in the native history. The error leaves the running CLI untouched.
