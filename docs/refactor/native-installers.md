# Native CLI installers

New installations default to the official shell scripts:

| CLI         | Bootstrap                            | Server-user executable     |
| ----------- | ------------------------------------ | -------------------------- |
| Codex       | https://chatgpt.com/codex/install.sh | `~/.local/bin/codex`       |
| Claude Code | https://claude.ai/install.sh         | `~/.local/bin/claude`      |
| OpenCode    | https://opencode.ai/install          | `~/.opencode/bin/opencode` |

The server downloads a bounded script, accepting only each vendor's documented HTTPS bootstrap redirect, then runs the fixed shell and arguments. OpenCode uses `--no-modify-path`. No sudo is used. Existing executables are never replaced. A successful job requires a native executable inside the server user's home and a valid version response. Shutdown cancels the installer process group; staging files are removed. The vendor script may leave native files after failure; AgentPier deliberately does not delete these files automatically.

Runtime HOME stays the server user's home. Managed account credentials continue to use their separate CLI configuration directories. Claude and OpenCode retain native automatic-update support. Codex uses its native distribution; update behavior also depends on its selected CODEX_HOME, so automatic updates across every managed profile are not promised.

The explicit owner-only `POST /api/tools/:id/install` body `{ "method": "npm" }` retains the private npm fallback for the three coding CLIs. Its fixed packages, staging/verification and non-overwrite behavior remain covered by the legacy installer tests. The normal UI defaults to native installation. GitHub CLI continues to use verified official release archives in AgentPier's private data directory.

Validation covers all three native installer jobs in disposable homes, npm fallback, platform/architecture availability, download bounds, approved/rejected redirects, executable version checks and shutdown. Official bootstrap scripts were also fetched using real HTTPS without executing them on the development user's home. No global CLI was installed on the development MacBook.

After deployment, all three official installers also succeeded on the Mac mini in fresh disposable homes using the deployed ToolInstaller: Codex 0.153.4, Claude Code 2.1.263 and OpenCode 1.18.29. Each resulting native binary passed its version check; all temporary installations were removed. Existing user installations and credentials were preserved.
