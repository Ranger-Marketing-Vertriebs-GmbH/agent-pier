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
  permanently; delete an entry and the agent asks again. Temporary team members get
  shell access only through their lead's **Team members may use shell and SSH**
  (see below).
- **Skills:** **Bundled skills** lists the skills that ship with OpenClaw. A skill
  teaches the agent a tool, mostly a command-line program such as `gh`. Switch on the
  ones this agent may use; each one shows whether it is ready or what it is missing,
  and risky skills show a warning first. A skill is a hint, not a permission: most
  skills need shell access, and shell access decides what the agent can run. Agents
  with memory can also read the instructions of their installed skills. These
  agent skills are separate from the CLI skills under **Extensions**
  ([shared CLI extensions](shared-cli-extensions.md)).
- **MCP servers:** the central servers bound to this agent. Add servers under
  **Accounts → MCP servers**; the wizard's **Connect** step can bind them to agents
  directly (**Manage MCP servers** links there); OAuth servers
  are signed in from AgentPier ([MCP](mcp.md#central-mcp-servers-in-the-coding-clis)).
  A local server can also be installed from an npm or PyPI package under **Accounts → MCP
  servers** ([MCP](mcp.md#installing-a-server-package)).

Saving can restart the agent service briefly; AgentPier asks first and refuses the
save while an affected agent is busy.

### Memory

An agent remembers only what it writes down: its conversation gets shortened
(compacted) when it grows long, and older turns are cut. With **Remember
information** on, AgentPier tells the agent to write durable facts and plans to
`MEMORY.md` and day notes to `memory/YYYY-MM-DD.md` as soon as you share them, and
never to say it saved something unless the write succeeded. Before a conversation
is shortened, the agent gets one last chance to append to the day note.

Shortening a long conversation can take a few minutes before the agent answers.
Meanwhile the chat shows **Summarising the conversation so far — this can take a few
minutes for long chats.** instead of **Working**, and the header shows **Summarising
conversation**. Afterwards a quiet line such as **Earlier messages were summarised
(about 251k → 18k tokens).** marks the place in the chat. Both appear only in
AgentPier; nothing is sent to the paired Telegram chat.

Only your own messages (in the chat or the paired Telegram chat) and its routines'
runs can change an agent's memory. Forwarded content, reminders, check-ins and tasks
from a lead agent cannot. When a write is refused, the chat shows a quiet line such as
**Memory not saved: only your own messages can change memory.** Right after the
agent service starts, a message waits a few seconds until memory can be written; if
it still cannot, the chat says the message ran read-only. **Memory** in the agent's
settings shows what was actually saved. Project knowledge that an agent proposes
(**Work**) waits for your approval; when you decline it or it expires, the agent is
told it was not saved.

### Work

- **Projects and coding tasks:** **Allowed projects**, **Allowed pipelines**, whether
  the agent may propose project memory updates, start selected coding pipelines
  without another approval, and publish pull requests. **Actions and coding tasks**
  lists what it proposed and what waits for your decision
  ([agent workflows](assistant-workflows.md)).
- **SSH accesses:** the hosts from **Settings → Access → SSH accesses** this agent may
  run commands on, each with a mode. **With approval** (the default) shows every
  command in the chat and in the paired Telegram chat with **Allow once** and **Deny**;
  a command with hidden characters or more than 2,000 characters can only be allowed
  in AgentPier. **Trusted** runs without asking in your own chats and in tasks or
  questions from the agent's lead. Every run, trusted or allowed, leaves a line such as
  "SSH on opnsense: uptime · done" in the chat; a denied command leaves none.
  **Trusted incl. routines** also runs in the agent's routines.
  Every command is listed under **Actions and coding tasks** and recorded in the
  activity log by its fingerprint, never its text. Agents cannot add hosts or keys.
- **Team:** **Allow teams without asking each time**, **Team members may use shell
  and SSH** (off by default; see [teams](#teams-asks-and-tasks) below), **Maximum team size** and
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
  AgentPier's own tools or session tools for them, so shell must be off, stdio
  servers removed and SSH accesses removed before you connect such a bot.

## Teams, asks and tasks

An agent can lead a team. By default it proposes a team and waits: approve or decline
the proposal in its chat or in Telegram. `/team <task>` or **Allow a team for this
message** behind **+** in the composer allows one team for one request; **Allow teams
without asking each time** allows them in general. Temporary members get their own
chat, finish with the task and can be kept with **Keep as permanent agent**.
Permanent members stay under their lead in the sidebar. Every member row and chat header
shows the model the member actually runs on:

- **Temporary members** always use the lead's current model. Change the lead's model
  and its temporary members use the new one from their next turn on; the member's own
  Profile revision does not change. A model chosen for a temporary member in an earlier
  AgentPier version is ignored. When the lead's model connection is removed or
  unavailable, they stop working with the same hint as the lead until you choose
  another model for the lead.
- **Permanent members** have their own model. A member kept with **Keep as permanent
  agent** takes over the lead's model of that moment; later changes to the lead do not
  affect it. Change it in the member's Profile.

The lead decides what each temporary member gets, and can only give what it has
itself: web search, web pages, browser, images, skills, its MCP servers, a read-only
copy of its memory and reminders. Without a choice of the lead a member gets memory,
web search and web pages; so do members from teams that started before grants
existed. The team proposal lists what every member gets. While a member works on
its task, and also after it finished as long as the lead can still ask it questions
or give it tasks (it is not archived or kept as a permanent agent), the lead can
grant it more or take grants back; each change shows on
the team card, as a note in the member's chat and the lead's chat, and in the
member's **Capabilities → Granted by the lead agent**, and it is recorded in the
activity log. Grants follow the lead: if it loses a capability, its members lose it
too. A reminder a member sets is created on the lead, listed in the lead's settings
and sent to the lead's Telegram chat. Members never get the team tools or routines
and cannot save to memory.

Shell and SSH need **Team members may use shell and SSH** in the lead's **Work** tab.
With it on, the lead may grant members of teams proposed from then on at most its
own shell level and its SSH accesses; the proposal marks those members with a
warning, and such a proposal always waits for your approval, even when teams are
otherwise allowed without asking. A shell or SSH grant the lead makes later asks
you for approval in the lead's chat and in Telegram. A member's shell request never
offers **Always allow**. Switching the setting off takes shell and SSH away from
running members and cancels waiting requests for good; switching it on again
restores nothing. The members of one team set at most five reminders on the lead,
and each one is noted in the lead's chat. Kept as permanent agents with **Keep as
permanent agent**, members keep only the MCP servers you saw in the proposal and
their own memory (not the copy of the lead's), and otherwise start with their own
settings.

A lead can also keep a useful member as a permanent agent itself. This takes effect
at once; you see a note in both chats and in the member's history, and a Telegram
notice if the lead has a paired chat. The new agent keeps what it worked with as its
own settings (web and image tools, skills, MCP servers, reminders), but never shell
or SSH, which you set yourself. It keeps only its own memory, which it can write;
the copy of the lead's memory is removed. Its name and
instructions stay, and it stays under its lead. You can archive it at any time.

A lead also talks to its members directly:

- It can **edit** its temporary members while they work or later, as long as it can
  still reach them: their name, role and assignment, additional instructions, or
  their whole instructions, even ones you edited yourself. Each change shows as a
  note in the member's and the lead's chats and in the member's **Capabilities →
  Granted by the lead agent** history, which also keeps, for you only, the
  instructions the last five changes replaced. It takes effect from the member's
  next turn.

- It can **ask** any of its members a question and **delegate** a task to a permanent
  member. The answer comes back to the lead, and to Telegram when the request came
  from there. The member's chat shows the request as "from <lead>".
- **These questions and tasks run without an approval prompt.** The member works with
  its own capabilities: a member with full shell access or bound MCP servers uses them
  without asking; a member whose shell is set to approval still asks you before each
  command. A permanent member uses only its own SSH accesses, never its lead's; an SSH
  command on a host set to **With approval** shows its card in the member's chat and in
  the lead's chat.
- Questions never write files. A task may change files in the member's workspace only
  when you asked for it yourself in the same message: name the member and say to ask
  or delegate, or mention it with `@`. Type `@` in the lead's composer to pick a
  member; Telegram understands `@Name` too. Negations such as "don't" or "read-only"
  in the message cancel that permission.
- **Work → Teams → Questions and tasks** lists every request, open ones first, marked
  "may write" or "read-only", with **Cancel** for open ones.
- Member reports and answers reach the lead whole up to 65,536 characters. A longer
  one is marked shortened, and the team card or request shows "Shortened" with **Open
  chat**, where the whole text is. When a team's reports together are too long for the
  lead's summary request, the longest are shortened for the lead, which is told that
  the whole reports are in the members' chats.

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
  watches, so with full shell access they act without asking. A routine can run SSH
  commands only on hosts set to **Trusted incl. routines**; on any other host it is
  refused and its result says so.
- **Check in on its own** (under **Acting on its own**) lets the agent look at its
  conversation and notes every hour, every 2 or 4 hours or once a day, within active
  hours, and write only when something needs your attention. It needs **Remember
  information**. Each check-in costs a model run.

## Messages while the agent works

While the agent works on a message, **Stop** replaces the send button and is the only
way to stop the turn. Pressing Enter, or choosing **Send when done** next to **Stop**
(also on phones and tablets, where Enter starts a new line), queues the next message
instead: the composer clears and the message waits above it with "Will be sent when
_agent_ is done". A further message joins the queued one on a new line; each chat holds
one queued message of at most 65,536 characters and five files. If any part allows a
team (**Allow a team for this message**), the whole queued message does. **Edit** takes
it back into the composer, before any text typed since, with its files. An archived
agent takes no queued messages.

AgentPier keeps the queued message on the server, so a reload, another tab or device
and a restart still show it. Once the turn ends, also when it failed or you stopped it,
the server sends the queued message once, with its files and team permission, through
the normal send. An uncertain or interrupted turn holds it until you resolve that turn;
while the agent service is not ready the notice says the agent cannot take messages
right now. If the agent refuses it, for example because a file is gone, the notice
shows the reason; such a message takes no more text until **Edit** brings it back. When
delivery keeps being refused for a while, the notice says that AgentPier keeps trying.
A queued message that could have gone out for a day without being sent (for example on
a host that was stopped or restored) is not sent anymore and says so; a long turn never
expires it. Its files stay with it until it is sent or taken back, also while it is
failed or expired: **Edit** returns them to the composer.

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
- Leads and their temporary members work unattended. Content they read can steer a
  lead into granting its members more (never more than it has itself) and a member
  into using what it was granted; with **Team members may use shell and SSH** on,
  that can include the lead's shell level and SSH accesses. Every grant is shown in
  the chats and on the team card, and later shell or SSH grants wait for you.
- Web pages can contain instructions meant to mislead an agent; switch on web tools
  only for agents whose other tools you would trust with that.
- **SSH accesses** set to **Trusted** run commands without asking. Commands the agent
  derives from web pages, documents, MCP results or remote output could therefore run
  without your confirmation; keep **With approval** for hosts where that matters. SSH
  for agents is convenience scoping under your user account, not a sandbox: an agent
  with **Full access** shell can read AgentPier's SSH key files.

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
