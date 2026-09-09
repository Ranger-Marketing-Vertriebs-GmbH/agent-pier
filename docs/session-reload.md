# Reload and resume

Use **Reload & resume** in a Codex, Claude Code or OpenCode session to restart its native CLI with refreshed integrations. This also makes newly installed AgentPier SSH tools available in an existing conversation.

AgentPier verifies the native conversation ID before stopping the CLI and resumes that exact conversation. The AgentPier session ID, working directory, account, attachments, saved chat draft and SSH assignments remain attached to the same session. A reload does not resend chat messages or start a fresh conversation. Login, shell, pipeline and imported historical sessions are excluded.

Choose **After the response** to wait until the CLI is confirmed idle. The queued action is visible and can be cancelled. If the CLI activity cannot be identified, it keeps waiting. Immediate reload during an active or unrecognized state requires acknowledgement that the current step will be interrupted. Saved conversation history survives; unfinished tool calls or remote work cannot be guaranteed to resume automatically. Check their outcome before asking the agent to repeat them.

If preflight validation fails, the existing CLI keeps running. If startup fails after the CLI has stopped, the session retains its verified conversation identity for a deliberate retry. Queued actions survive a web-service restart. Restored backups contain historical sessions, without queued reload actions or live tool capabilities.

The native CLI must still have access to its saved conversation files. AgentPier does not fall back to whichever conversation was most recent when the exact conversation cannot be resolved.

If the restarted CLI asks you to allow hooks or trust the project, choose **Open terminal** in the reload dialog to confirm it yourself. This closes the dialog without cancelling the reload. Direct terminal input is available as soon as the replacement CLI is running, including while AgentPier is verifying the resumed conversation. Chat delivery and model controls remain blocked during that verification. If verification times out while you are reading a prompt, the terminal remains available to finish the approval.

## Model verification

Reload preflight checks the current model before stopping the CLI. If the CLI reports only a display name that cannot be resolved reliably, AgentPier rejects the reload instead of forcing an older model from the conversation history. This currently affects some OpenCode display names and unfamiliar native model labels. Changing the model immediately before reloading can also require a new response to confirm its exact identity in the native history. The error leaves the running CLI untouched.
