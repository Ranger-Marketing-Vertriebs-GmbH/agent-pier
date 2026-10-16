# AgentPier documentation

Start with the [README](../README.md) for installation and first steps. Guides marked
_(German)_ are not translated yet.

## Use

| Guide                                                      | What it covers                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| [Providers and accounts](providers.md)                     | Provider connections, native CLI accounts and model catalogs |
| [Continue with another account](session-account-switch.md) | Moving a session to another account                          |
| [Reload and resume](session-reload.md)                     | Restarting a session onto the current CLI and release        |
| [Code changes in chat](chat-code-changes.md)               | Diffs and file changes shown in the chat                     |
| [Mobile delivery](mobile-delivery.md) _(German)_           | Sending messages from the phone and recovering them          |
| [Mobile recovery](mobile-recovery.md)                      | Connection and upload recovery on phones                     |
| [App and notifications](notifications.md)                  | Installing the app, push notifications and devices           |
| [File Explorer](file-explorer.md)                          | Browsing, editing, uploading and recovering files            |
| [Pipelines](pipelines.md)                                  | Task profiles, review pipelines and runs                     |
| [Project memory](memory.md)                                | Shared project knowledge for sessions and agents             |
| [AgentBus](agentbus-integration.md) _(German)_             | Messages between sessions in the same project                |
| [Artifacts](artifacts.md)                                  | Private pages published from sessions and agents             |
| [MCP](mcp.md)                                              | AgentPier's MCP access for CLIs and central MCP servers      |
| [SSH accesses](ssh-access.md)                              | SSH keys and hosts for projects, sessions and agents         |
| [GitHub connections](github-agents.md) _(German)_          | Tokens for clones and pull requests                          |
| [Shared CLI extensions](shared-cli-extensions.md)          | CLI skills, plugins, marketplaces and Agency agents          |
| [Codex context](codex-context.md)                          | Codex context windows and model status                       |
| [Sandboxed sessions](sandbox.md)                           | The optional nono sandbox for CLI sessions                   |

## Agents

| Guide                                               | What it covers                                              |
| --------------------------------------------------- | ----------------------------------------------------------- |
| [Agents](agents.md)                                 | User guide: setup, capabilities, skills, teams and Telegram |
| [Agent workflows](assistant-workflows.md)           | Project access, coding tasks and routines                   |
| [Model connections](assistant-model-connections.md) | Models and ChatGPT accounts for agents                      |
| [Runtime updates](assistant-runtime-updates.md)     | Updating and rolling back the managed OpenClaw runtime      |
| [Gateway design](assistant-gateway.md)              | Design and limits of the managed agent service              |

## Operate

| Guide                                              | What it covers                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [Installation on macOS](installation.md)           | Installer, service, updates and [upgrading from 1.x](installation.md#upgrading-from-1x) |
| [Linux](linux.md) _(German)_                       | Installation and service on Linux                                                       |
| [Remote access](remote-access.md) _(German)_       | Tailscale Serve and network mode                                                        |
| [Login](login.md) _(German)_                       | Workspace user, sessions and recovery                                                   |
| [Backups](backups.md)                              | What a backup holds, its format and restoring it                                        |
| [Operations and portability](operations.md)        | Storage, restore, moving hosts, release packages and installer                          |
| [Stable and Preview releases](release-channels.md) | Update channels and release candidates                                                  |
| [CLI updates](cli-updates.md)                      | Installing and updating the coding CLIs                                                 |
| [Installer distribution](homebrew-maintenance.md)  | Maintaining the installer release and Homebrew tap                                      |

## Design

| Document                                                  | What it covers                                          |
| --------------------------------------------------------- | ------------------------------------------------------- |
| [Architecture](architecture.md)                           | Boundaries of the server, web app and features          |
| [Settings pattern](settings-pattern.md)                   | The shared layout and save model of settings pages      |
| [ADR 0001](adr/0001-optional-per-session-nono-sandbox.md) | Optional per-session nono sandbox                       |
| [ADR 0002](adr/0002-managed-openclaw-assistants.md)       | Managed OpenClaw agents and visible agent teams         |
| [ADR 0003](adr/0003-agent-ssh-access.md)                  | SSH access for agents                                   |
| [Protocol adapter](protocol-adapter.md)                   | How custom endpoints are adapted to each CLI's protocol |
| [Startup loading](startup-loading.md)                     | The startup screen shown before the app loads           |
| [Chat observability](chat-observability.md)               | Chat context and subagent observations                  |
| [Native chat delivery](native-chat-delivery.md)           | How chat messages reach the native CLIs                 |
| [AgentBus broker](agentbus.md)                            | Broker and queue behind AgentBus                        |
| [Testing](testing.md)                                     | Test suites and the CI tiers                            |
| [Design contracts](refactor/design.md)                    | The original architecture and completion contract       |

## Evidence

Qualification and validation logs record how a behavior was verified, with the versions
used at the time. They are not maintained as user guides.

- Agent runtime: [MCP clients](assistant-mcp-qualification.md),
  [memory](assistant-memory-qualification.md),
  [native interface](assistant-native-interface-qualification.md),
  [providers](assistant-provider-qualification.md),
  [releases](assistant-release-qualification.md),
  [routines](assistant-routine-qualification.md),
  [shell](assistant-shell-qualification.md),
  [Telegram bots](assistant-telegram-senders-qualification.md),
  [web tools](assistant-web-tools-qualification.md).
- MCP: [central servers in the CLIs](cli-mcp-qualification.md),
  [OAuth](mcp-oauth-qualification.md).
- Chat and sessions: [Claude model switch](claude-model-switch-validation.md),
  [direct chat TUI](direct-chat-tui-validation.md),
  [chat prompt guards](native-chat-prompt-validation.md),
  [session activity](session-activity-validation.md).
- [Audits](audits/2026-09-12-resolution.md), [research notes and spikes](research/)
  and [implementation reports](refactor/).
