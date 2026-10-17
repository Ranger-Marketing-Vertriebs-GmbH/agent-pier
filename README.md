# AgentPier

**Your coding CLIs and personal agents, on your own machine.**

Self-hosted workspace for coding CLIs (Codex, Claude Code, OpenCode) and persistent
personal agents. Native terminals and chat on desktop and phone, reviewed pipelines,
and agents that work as a team.

[Deutsch](README.de.md) · [Docs index](docs/README.md) ·
[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [License](LICENSE)

![AgentPier with an agent chat, a team member and coding sessions in the sidebar](docs/screenshots/agentpier-agent-chat-desktop.png)

<img src="docs/screenshots/agentpier-agent-chat-phone.png" alt="The same agent chat on a phone" width="260">

## What you get

- **Native CLI sessions:** real tmux-backed terminals with each CLI's own login,
  models and prompts, plus a chat view that recovers on the phone
  ([reload and resume](docs/session-reload.md), [mobile delivery](docs/mobile-delivery.md)).
- **Pipelines with review:** reusable profiles, isolated Git worktrees, bounded
  review loops, checks and human approval ([pipelines](docs/pipelines.md)).
- **Agents and teams:** persistent agents whose leads ask and delegate to their
  members, with @-mentions, Telegram, skills, routines, check-ins and attachments
  ([agents](docs/agents.md)).
- **Central MCP servers:** add a server once and bind it to agents and to your coding
  CLIs, with OAuth sign-in from AgentPier ([MCP](docs/mcp.md)).
- **Accounts hub:** native CLI accounts, provider connections, ChatGPT for agents and
  agent services in one place ([providers](docs/providers.md)).
- **Files and knowledge:** a file explorer, private artifacts, shared project memory
  and AgentBus between sessions ([files](docs/file-explorer.md),
  [artifacts](docs/artifacts.md), [memory](docs/memory.md),
  [AgentBus](docs/agentbus-integration.md)).
- **Phone-first:** install as an app, push notifications, and delivery and upload
  recovery ([notifications](docs/notifications.md), [mobile recovery](docs/mobile-recovery.md)).
- **Operations:** backups, updates with Stable and Preview channels, and an activity
  log ([backups](docs/backups.md), [release channels](docs/release-channels.md)).

## Requirements

- macOS 14 or later (Apple Silicon or Intel), or Linux on x64 or arm64.
- Node.js 22.13 or later (bundled in release packages), Git and tmux.
- Optional: Tailscale for remote access, and a Chromium-based browser for the agents'
  browser tool.
- At least one coding CLI or model provider. Provider accounts and their costs are
  your own.

## Install

**macOS, install script.** Installs prerequisites and the login service:

```sh
(agentpier_tmp=$(mktemp -d) && trap 'rm -rf "$agentpier_tmp"' EXIT && curl --fail --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases/latest/download/install-agentpier.sh -o "$agentpier_tmp/install.sh" && /bin/sh "$agentpier_tmp/install.sh")
```

**macOS, Homebrew:**

```sh
brew install ranger-marketing-vertriebs-gmbh/tap/agentpier-installer && agentpier-install
```

Both open AgentPier at **http://127.0.0.1:4380**. Options:
[installation guide](docs/installation.md#one-command-installation-on-macos).

**Linux.** Download the `.aprelease` package for your architecture from the
[releases](https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases)
and install it with `sh scripts/install.sh --archive <package> --service` from a
checkout. See the [Linux guide](docs/linux.md) and the
[exact commands](docs/operations.md#installer-and-exact-commands).

**From source (macOS or Linux):**

```sh
git clone https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier.git
cd agent-pier
npm ci
npm run build
npm start
```

## First steps

1. Open **http://127.0.0.1:4380** and create the workspace user. Later visits need the
   [login](docs/login.md). Finish this before you share access.
2. Open **Accounts** from the sidebar **Menu**: sign in to a coding CLI under
   **Native CLI accounts**, or add a provider connection under **Model access**.
   Missing CLIs can be installed from the overview.
3. Choose **New → Session**, pick a CLI, an account and a project folder, and start.
   The native terminal handles CLI logins and menus; the chat shows the saved
   conversation.
4. Optional: switch on agents under **Settings → Workspace → Agents → Enable agents**
   and create one under **Agents** ([agents guide](docs/agents.md)).

Choose German or English under **Settings → Workspace → General → Language**.
Stopping the web server leaves CLI sessions running; stop a session in the interface
to end its CLI process.

## Update

Installed versions update under **Settings → Operations → Updates**, on the
**Stable** or **Preview** channel ([release channels](docs/release-channels.md)). A
failed start returns to the previous version. Coding CLIs update from the overview
([CLI updates](docs/cli-updates.md)); a CLI AgentPier installed cannot start sessions
below its minimum version until it is updated. A source checkout updates with `git pull`,
`npm ci` and `npm run build` ([updating](docs/installation.md#6-updating)).

> **Upgrading from 1.x**
>
> - Backups made by 2.0 cannot be restored on 1.x. Take a backup before updating if
>   you might roll back.
> - Sign in again once to OAuth MCP servers used from managed Codex accounts.
> - Lead agents now ask and instruct their members without an approval prompt.
> - Settings moved into the Workspace, Access and Operations tabs; old links still work.
> - Backups copy CLI profiles by allowlist, include histories (AgentPier's sessions,
>   chats and AgentBus messages, and CLI histories) only encrypted with a passphrase,
>   and restored hook scripts need `chmod +x` again.
>
> Details: [Upgrading from 1.x](docs/installation.md#upgrading-from-1x).

## Guides

The [docs index](docs/README.md) lists every guide.

| Area    | Guides                                                                                                                                                                                                                      |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Use     | [Providers](docs/providers.md) · [Pipelines](docs/pipelines.md) · [Files](docs/file-explorer.md) · [Artifacts](docs/artifacts.md) · [MCP](docs/mcp.md) · [SSH](docs/ssh-access.md) · [Notifications](docs/notifications.md) |
| Agents  | [Agents](docs/agents.md) · [Workflows](docs/assistant-workflows.md) · [Model connections](docs/assistant-model-connections.md) · [Runtime updates](docs/assistant-runtime-updates.md)                                       |
| Operate | [macOS](docs/installation.md) · [Linux](docs/linux.md) · [Remote access](docs/remote-access.md) · [Backups](docs/backups.md) · [Operations](docs/operations.md) · [Sandbox](docs/sandbox.md)                                |
| Develop | [Architecture](docs/architecture.md) · [Settings pattern](docs/settings-pattern.md) · [Testing](docs/testing.md) · [Frontend](web/README.md) · [Contributing](CONTRIBUTING.md)                                              |

## Data and security boundaries

AgentPier is a trusted personal workspace, not an isolation boundary between users.
Its data lives in `.data/` for a source checkout and in
`~/Library/Application Support/AgentPier` for a macOS installation. The data holds
credentials, profiles, session metadata and conversations with private file
permissions, but is not encrypted at rest. The login protects the web workspace;
[remote access](docs/remote-access.md) explains Tailscale Serve and the network mode.

Coding CLIs and agents run as your operating-system user. The optional
[nono sandbox](docs/sandbox.md) confines CLI sessions only, not agents. An agent with
shell access works with your logins, files and keys; local MCP servers run commands
on the host; an agent's own Telegram bot answers the people you allow; and a lead
agent's questions and tasks run on its members without approval. See
[SECURITY.md](SECURITY.md).

## Development

```sh
npm ci
npm run check
npx playwright install chromium webkit
npm run test:e2e
AGENTPIER_TEST_BROWSER=webkit npm run test:e2e
```

For frontend development, run `npm start` for the backend and `npm run dev` in a
second terminal. Vite proxies `/api` and `/auth` to the backend.

Bug reports, documentation improvements and focused pull requests are welcome.
Start with [CONTRIBUTING.md](CONTRIBUTING.md), the [testing guide](docs/testing.md)
and the [frontend architecture](web/README.md). Report vulnerabilities privately
using [SECURITY.md](SECURITY.md).

## License

AgentPier is licensed under [Apache-2.0](LICENSE). Bundled AgentBus retains its
[MIT license](vendor/agentbus/LICENSE). Dependencies and provider marks retain
their respective notices and rights; see [third-party notices](THIRD_PARTY_NOTICES.md).
