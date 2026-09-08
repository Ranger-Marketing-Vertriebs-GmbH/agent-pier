# AgentPier: chat, tasks and repositories

This supersedes the original raw mobile terminal reader. User requests a remote-chat-like reader, a tasks panel only in that view, GitHub and GitHub Enterprise tokens and local repository cloning, the name AgentPier, and installation instructions without installing the app on this MacBook.

## Chat and tasks

Keep native PTY/TUI interaction and account isolation. The reader consumes structured provider history, never scraped terminal rows. Render user and assistant Markdown messages, collapsible tool calls/results and a left-hand task list (collapsible above messages on mobile). Preserve code formatting, message identity and scroll position. Task state comes from Claude TodoWrite/TaskCreate/TaskUpdate, Codex update_plan, and OpenCode todowrite; missing tasks mean an honest empty state. Keep native approvals in Terminal with an explicit switch, without manufacturing buttons from text.

Bind every reader to an exact provider conversation ID and account. New Claude sessions get their own --session-id. Existing sessions and providers with opaque IDs offer a same-project conversation selector, persisted once chosen; never guess the most recent session when several accounts or sessions exist. Claude reads bounded JSONL transcripts, Codex uses read-only app-server thread/list and thread/read (with paginated turns where required), and OpenCode uses its session list/export CLI. No provider model requests during automated verification. Native chat input goes to the already-running PTY; session ownership and terminal mode are unchanged.

## GitHub and repositories

A separate credential store saves multiple named access tokens, including several for the same host. Host input accepts an HTTPS origin (github.com or an Enterprise host, optional explicit port), rejects paths, userinfo, HTTP and control characters. Persist metadata separately from private token files; never return token values to the UI. Edit keeps a blank token unchanged; delete removes only that profile.

Clone takes credential ID, HTTPS repository URL or owner/repo shorthand, an existing parent directory and a new folder name. Exact origin matching is mandatory. Use Git argument arrays and an ephemeral credential helper scoped to that origin. Disable redirects, inherited Git credential/config helpers, hooks, submodules and interactive prompts for the clone. Never put tokens in arguments, URLs, .git/config, browser responses or raw errors. Reserve the destination exclusively; existing paths are never overwritten. Return a useful sanitized failure and clean up only a destination created by this operation. A successful clone is stored as a local project and can launch a CLI via the existing session dialog.

## Installation and identity

UI and package use AgentPier. Preserve legacy TUIUI environment and tmux naming for existing sessions, adding AGENTPIER aliases. Keep app startup and optional macOS autostart/Tailscale setup explicit and documented. No service installation or remote publishing as part of this development task. The mistakenly created dev.tuiui.server LaunchAgent and dedicated Serve mapping have been removed, while the user's active tmux session and data remain intact.

## Verification

Reproduce Unicode loss with no locale before forcing UTF-8 for browser tmux clients. Unit/integration coverage for provider normalization, tasks, exact binding and profile separation, partial log records, malformed data, Git origin matching, credential redaction, destination collision and a real local Git HTTP clone fixture. Browser tests cover clean mobile chat, task panel, switching back to the native terminal, token CRUD, cloning and session directory handoff. All test servers and CLIs use temporary data and are cleaned up.
