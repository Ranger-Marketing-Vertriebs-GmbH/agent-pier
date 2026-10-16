# Agents

Agents are persistent assistants that keep their own chat, notes and tools. AgentPier
runs them in one managed [OpenClaw](https://docs.openclaw.ai/) service on
your host. This guide covers what you set up and where. The design and the exact
limits are in the [Gateway design](assistant-gateway.md),
[model connections](assistant-model-connections.md) and
[agent workflows](assistant-workflows.md).

![Agent chat with a team member in the sidebar](screenshots/agentpier-agent-chat-desktop.png)

## Turn agents on

1. Open **Settings → Workspace**. Under **Agents**, switch on **Enable agents** and
   save. AgentPier downloads the pinned OpenClaw runtime and its own Node.js into the
   data directory; nothing is installed globally. Installers can do this in advance
   with `--with-assistants` (see [installation](installation.md#managed-assistant-runtime)).
2. **Settings → Workspace → Agents → Agent service** shows the service, its
   synchronization and its runtime version. Start, stop or restart the service there,
   and prepare, activate or roll back OpenClaw updates
   ([runtime updates](assistant-runtime-updates.md)).
3. **Agent service → Advanced settings** offers a short, allow-listed set of OpenClaw
   settings for all agents: **Time limit per task**, **Thinking level**, **Time zone**,
   **Image quality**, **Maximum image size** and **Media file retention**. Each one is
   marked **Immediate** or **Restart needed**. AgentPier offers only settings that do
   not touch security, access or management, and applies them only to the runtime
   version they were approved for; an older runtime starts with OpenClaw's defaults.
   The activity log records each change as `setting.updated` with the setting and its
   old and new value.

While agents are off, AgentPier shows no agent navigation and runs no agent
connections or background work.

## Create an agent

Agents need a model. Set one up under **Accounts → Model access**: connect
**ChatGPT for agents** with a device-code sign-in, or add a provider connection
(OpenRouter, Ollama, llama.cpp or another OpenAI-compatible endpoint).

Then open **Agents** from the sidebar **Menu** and choose **New agent**. Give it a
**Name**, **Instructions**, a **Model connection** and a **Model**. For ChatGPT
accounts the list shows the models your account can use and says when it could not
be refreshed. The agent appears in the sidebar under **Agents**; its chat opens there.

## Agent settings

**Settings** in the agent's chat header opens four tabs.

### Profile

Name, instructions and model. A team member also shows where it came from and whether
its instructions changed since it was created. A temporary member has no model of its
own: its Profile shows the lead's model with "Follows the lead's model." A permanent
member also shows whether its model changed since it took it over from the lead.

### Capabilities

- **Memory & reminders:** **Remember information** keeps the agent's own notes
  between conversations; **Memory** opens and searches them. **Allow Telegram
  reminders** lets it send reminders and run routines through Telegram.
- **Web & documents:** **Search the web**, **Read web pages**, **Use a browser** (a
  separate browser profile; needs Chrome, Brave, Edge or Chromium on the host) and
  **Read images**. The search provider is set once under
  **Accounts → Services for agents → Web search** (DuckDuckGo, Brave Search or
  Perplexity through OpenRouter).
- **Shell access:** **Off**, **With approval** or **Full access**. With approval, the
  agent asks before every command that is not always allowed; the request appears in
  the chat and in the paired Telegram chat with **Allow once**, **Always allow** and
  **Deny**. A permanent team member asks in its own chat; when its lead asked or
  delegated the turn, the request also appears in the lead's chat, and deciding in
  either chat settles it in both. **Always allowed commands** lists what you allowed
  permanently; delete an entry and the agent asks again. Temporary team members never
  get shell access.
- **Skills:** **Bundled skills** lists the skills that ship with OpenClaw. A skill
  teaches the agent a tool, mostly a command-line program such as `gh`. Switch on the
  ones this agent may use; each one shows whether it is ready or what it is missing,
  and risky skills show a warning first. A skill is a hint, not a permission: most
  skills need shell access, and shell access decides what the agent can run. Agents
  with memory can also read the instructions of their installed skills. These
  agent skills are separate from the CLI skills under **Extensions**
  ([shared CLI extensions](shared-cli-extensions.md)).
- **MCP servers:** the central servers bound to this agent. Add and bind servers
  under **Accounts → MCP servers** (**Manage MCP servers** links there); OAuth servers
  are signed in from AgentPier ([MCP](mcp.md#central-mcp-servers-in-the-coding-clis)).
  A local server can also be installed from an npm or PyPI package under **Accounts → MCP
  servers** ([MCP](mcp.md#installing-a-server-package)).

Saving can restart the agent service briefly; AgentPier asks first and refuses the
save while an affected agent is busy.

### Work

- **Projects and coding tasks:** **Allowed projects**, **Allowed pipelines**, whether
  the agent may propose project memory updates, start selected coding pipelines
  without another approval, and publish pull requests. **Actions and coding tasks**
  lists what it proposed and what waits for your decision
  ([agent workflows](assistant-workflows.md)).
- **Team:** **Allow teams without asking each time**, **Maximum team size** and
  **Member time limit (minutes)**.
- **Teams:** the agent's active and archived teams and, below them, **Questions and
  tasks** it sent to its members.

### Telegram

- **Connection:** create a dedicated bot with BotFather, paste its token under
  **Telegram bot token**, choose **Connect Telegram**, then **Pair my private chat**.
  Messages from that chat reach the agent's conversation and are marked "via
  Telegram"; replies go back to Telegram, a long one in full as several messages
  split between paragraphs or lines (beyond about 64,000 characters or 40 messages
  a closing note says the reply was shortened). **Telegram activity** shows deliveries that
  need a decision. Voice messages are transcribed when a Deepgram key is set under
  **Accounts → Services for agents → Speech recognition**.
- **Acting on its own:** see [check-ins](#routines-reminders-and-check-ins).
- **Reminders** and **Routines** (with **Allow Telegram reminders** on).
- **Telegram for other people:** gives the agent its own bot for people you choose,
  each with a separate conversation. Add each person by numeric Telegram user ID
  under **Allowed people**. The agent never uses shell, local (stdio) MCP servers,
  AgentPier's own tools or session tools for them, so shell must be off and stdio
  servers removed before you connect such a bot.

## Teams, asks and tasks

An agent can lead a team. By default it proposes a team and waits: approve or decline
the proposal in its chat or in Telegram. `/team <task>` or **Allow a team for this
message** behind **+** in the composer allows one team for one request; **Allow teams
without asking each time** allows them in general. Temporary members get their own
chat, finish with the task and can be kept with **Keep as permanent agent**.
Permanent members stay under their lead in the sidebar. Every member row and chat header
shows the model the member actually runs on:

- **Temporary members** always use the lead's current model. Change the lead's model
  and its temporary members use the new one from their next turn on. When the lead's
  model connection is removed or unavailable, they stop working with the same hint as
  the lead until you choose another model for the lead.
- **Permanent members** have their own model. A member kept with **Keep as permanent
  agent** takes over the lead's model of that moment; later changes to the lead do not
  affect it. Change it in the member's Profile.

A lead also talks to its members directly:

- It can **ask** any of its members a question and **delegate** a task to a permanent
  member. The answer comes back to the lead, and to Telegram when the request came
  from there. The member's chat shows the request as "from <lead>".
- **These questions and tasks run without an approval prompt.** The member works with
  its own capabilities: a member with full shell access or bound MCP servers uses them
  without asking; a member whose shell is set to approval still asks you before each
  command.
- Questions never write files. A task may change files in the member's workspace only
  when you asked for it yourself in the same message: name the member and say to ask
  or delegate, or mention it with `@`. Type `@` in the lead's composer to pick a
  member; Telegram understands `@Name` too. Negations such as "don't" or "read-only"
  in the message cancel that permission.
- **Work → Teams → Questions and tasks** lists every request, open ones first, marked
  "may write" or "read-only", with **Cancel** for open ones.

Check your members' shell levels and MCP servers before you let a lead use them.

## Routines, reminders and check-ins

All three need a paired Telegram chat and live in the agent's **Telegram** tab.

- **Reminders** send a one-time or daily text. You can also ask for one in the chat.
- **Routines** save a task prompt that runs daily or on an event (an owner request or
  a linked coding run that completed); **Run once** starts one now. A routine uses
  the agent's own tools and approvals (memory, its workspace files, web, browser,
  shell and MCP servers, as far as they are switched on) but cannot schedule, ask or
  delegate. Its whole result goes to the paired Telegram chat (several messages
  when it is long) and appears in the agent's
  chat marked "Scheduled · <name>"; a failed run shows a short line there. Routines
  read the chat's recent messages, including forwarded ones, and run while nobody
  watches, so with full shell access they act without asking.
- **Check in on its own** (under **Acting on its own**) lets the agent look at its
  conversation and notes every hour, every 2 or 4 hours or once a day, within active
  hours, and write only when something needs your attention. It needs **Remember
  information**. Each check-in costs a model run.

## Attachments

Choose **+ → Attach file or image**, paste or drag files into the agent chat, also in
a team member's chat. A message holds up to five files of at most 10 MB: JPEG, PNG,
WebP, GIF and HEIC images, PDF and text files. Copies are saved in the agent's
workspace so it can read them with its tools. Models that accept images (ChatGPT,
endpoint models that declare it, OpenRouter models whose catalog lists image input)
also see images directly; the composer says when the agent's model cannot. Attachments
are part of host backups.

## Security notes

- Agents run as your operating-system user. **Shell access** works with your logins,
  files and keys and is not sandboxed; the optional [nono sandbox](sandbox.md) applies
  to CLI sessions only.
- Local (stdio) MCP servers run commands on the host; AgentPier asks before you bind
  one.
- A bot for other people lets them use what the agent remembers and its web tools and
  remote MCP servers.
- A lead's questions and tasks run without approval and use its members'
  capabilities.
- Web pages can contain instructions meant to mislead an agent; switch on web tools
  only for agents whose other tools you would trust with that.

See [SECURITY.md](../SECURITY.md) for the reporting policy and the full trust model.

## Troubleshooting

- **Settings → Workspace → Agents → Agent service** shows whether the service runs and
  whether the agents' configuration is synchronized; **Technical details** shows the
  runtime version and more. Restart the service there if it does not become ready.
- **Settings → Workspace** shows an **Agent diagnostic** under **Agents** when agents
  could not be switched on or started.
- An agent whose model connection was deleted shows a hint in its chat header; choose
  another connection on its **Profile** tab.
- After a rollback to an older runtime, some features stay off until the qualified
  version runs again ([runtime updates](assistant-runtime-updates.md)).
