# Session reload and scoped SSH tools

Approved design: “Neu laden & fortsetzen” restarts the coding CLI using its exact native conversation and refreshed integrations. Preserve the AgentPier session ID, creation identity, account/provider/model, working directory, attachments, chat drafts/history and SSH assignments. Never guess a conversation or silently create a fresh one. Shell, login and pipeline sessions are excluded. Preflight failure leaves the process untouched. Restart failure remains recoverable using the same conversation.

Offer immediate reload with explicit interruption acknowledgement for busy/unknown activity, or queue until confirmed idle. Queued reload is visible and cancellable. Duplicate requests must not restart twice. Preserve durable recovery state across server restarts; never replay chat input as a restart side effect.

SSH tools are configured independently of AgentBus for Codex, Claude and OpenCode. Tools list only assigned hosts and execute commands through the existing strict host-key SSH connection builder. Private keys never enter browser responses or logs. Capabilities rotate per CLI launch; old tokens and removed assignments must fail. Bound input, output, execution time and concurrency. Show readiness only after the MCP process connects; existing sessions show reload required. Same-user OS processes are not sandboxed. Global ~/.ssh management is out of scope.

UI supports German and English and both chat and terminal. No automatic remote command is run by AgentPier. Tests use isolated data/tmux and synthetic credentials only.
