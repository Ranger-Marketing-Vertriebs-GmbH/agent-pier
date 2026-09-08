# AgentPier chat controls and repository discovery

User-authorized follow-up to the AgentPier plan. Existing feature branch retained.

- [x] Desktop Enter sends, Shift+Enter inserts newline; touch keyboards only send through button. Red/green browser tests.
- [x] Explicit native launch-mode allowlist and selector, default unchanged. Independent launch_modes task owns accounts and launch form.
- [x] Add GitHub repository remote and concrete clone instructions: kay-solutions/agent-pier.
- [x] Authenticated organization/repository search and anonymous public github.com clone. Independent repo_discovery task owns repository backend/UI/tests.
- [x] Current-model field and dropdown in chat using the running CLI's native model picker. Preserve draft and conversation. Native model/effort options, no hardcoded model versions. Verify menu state before each action; unknown/confirmation dialogs remain native. CLI output is used only for this control, never for chat history/tasks.
- [x] Added user-requested per-CLI MCP/skill management, skill upload/drop and public GitHub download. Show actual native scope, including shared Codex user skills. Preserve unrelated config and reject ambiguous edits.
- [x] Integration tests, production build, desktop/mobile browser verification and focused review. Final 102 backend tests and 39 browser tests pass; model layout rechecked with six scoped browser tests. Native selection tested in all three isolated CLIs without inference calls, then probes cleaned up.

No permanent MacBook installation, no changes to the user's existing Claude process. Only isolated test sessions and normal local web server. Native control uses verified installed CLI behavior and official documentation; never claim a model change from a sent key alone. OpenCode providers are included in model option labels; provider authentication remains native.
