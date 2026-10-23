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

**Start from a template** fills Name and Instructions from an Agency agent (a role
description from [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents),
MIT licensed); the preview of an entry under **Extensions › Agency agents** offers the same
as **Create agent**. Its model and tool settings are not imported: you choose the model,
and tools and access stay off until you grant them. AgentPier scans the entry first: a
blocked one cannot be used, and warnings are shown before you create the agent. The
agent's **Profile** names the template with its source, revision and license.

## Agent settings

**Settings** in the agent's chat header opens five tabs: **Profile**, **Capabilities**,
**Work**, **Routines & check-ins** and **Telegram**.

### Profile

Name, instructions and model. A team member also shows where it came from and whether
its instructions changed since it was created. A temporary member has **Follow the
lead's model** switched on unless it has a model of its own: its Profile then shows
the lead's model. Switch it off to
pick a model of its own; switch it on again to follow the lead. A permanent member, and
a temporary member with a model of its own, also shows whether its model changed since
it took it over from the lead.

### Capabilities

- **Memory & reminders:** **Remember information** keeps the agent's own notes
  between conversations; **Memory** opens and searches them. **Allow reminders and
  routines** lets it send reminders and run routines
  ([routines, reminders and check-ins](#routines-reminders-and-check-ins)).
- **Web & documents:** **Search the web**, **Read web pages**, **Use a browser** (a
  persistent browser profile of the agent's own; needs Chrome, Brave, Edge or
  Chromium on the host), **Read images**, **Read PDFs** and **Create images**
  (through a ChatGPT account connected under **Accounts → ChatGPT for agents**;
  without one the switch is disabled and says so). The search provider is set once
  under **Accounts → Services for agents → Web search** (DuckDuckGo, Brave Search or
  Perplexity through OpenRouter). **Read PDFs** reads PDF files in the agent's
  workspace with one PDF model for all agents, chosen under
  **Accounts → Services for agents → PDF reading** from the model connections and
  ChatGPT accounts. A model without image input reads the text of PDFs but not
  scanned pages or pages without text; the PDF reading page says so. Until a usable
  model is chosen the switch is disabled and says why. **Read images** also lets the
  agent look at PNG, JPEG, GIF and WebP files (up to 6 MiB) in the project folders
  you gave it, when its model takes images; each such view is recorded in the
  activity log with the file's path and size.
- **Agent browser** (while **Use a browser** is on): **Visible browser** opens a
  regular, minimized window instead of a headless one, so shop and product pages that
  block headless browsers work; open the window from the Dock or the window list to
  sign in. It needs a browser app of the agents' own, Brave, Chromium or Chrome for
  Testing, never the owner's Chrome, and on Linux a display. Without one,
  **Install browser** installs a managed Chrome for Testing with progress, then offers
  **Restart agent service**. **Open live view** (or the small preview in the chat header while
  the browser runs) shows the browser live at `/agents/<id>/browser`, also while its
  window is minimized, with its address and tabs; pick a tab or follow the agent, and
  start a stopped browser there. Only the owner sees it, and no pictures are stored. **Take over** there
  (or beside the chat preview) to sign in or solve a check yourself: the agent waits,
  and **Hand back** (or ten minutes without input) gives it back; if the agent tried
  the browser meanwhile, a note in the chat lets it continue. Shift+Escape leaves the
  browser's keyboard; **Take over here** moves control from another device. At most three visible
  browsers run at once, and a browser idle for 15 minutes stops. **Reset browser
  profile** deletes the agent's sign-ins and cookies, also for an archived agent. The chat header shows
  **Browser running** while it runs. Temporary team members get a browser profile
  that is discarded when they end. See "Browser isolation" in
  `docs/assistant-gateway.md`.
- **Shell access:** **Off**, **With approval** or **Full access**. With approval, the
  agent asks before every command that is not always allowed; the request appears in
  the chat and in the paired Telegram chat with **Allow once**, **Always allow** and
  **Deny**. A permanent team member asks in its own chat; when its lead asked or
  delegated the turn, the request also appears in the lead's chat, and deciding in
  either chat settles it in both. Every request waiting for approval, and every team
  proposal, also appears under **Agents** in the [inbox](inbox.md). **Always allowed commands** lists what you allowed
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
  servers** ([MCP](mcp.md#installing-a-server-package)). A local server's path setting
  can use an [agent placeholder](mcp.md#agent-placeholders) such as
  `{agent.workspace}`, so each agent reads and writes only in its own folder.

Switching a capability, the visible browser, skills or MCP servers applies while the
agent service keeps running. A few changes still need a brief restart of the agent
service: another web search provider or key, another PDF model, a browser installed
after the service started, a changed model connection that agents use, and a new
Telegram bot for an agent. AgentPier saves such a change at once and shows
**Agent service restart pending**, with what it is for and what it waits for. The
service restarts by itself as soon as no agent is busy; further changes join the same
restart. **Restart now** restarts at once after you confirm; it interrupts all running
agent work and can take about a minute or longer. Revoking access still restarts at
once after you confirm and is refused while an agent is busy: deleting a connection
agents use or changing or removing its key, removing an agent's bot or replacing its
token, and changing or removing the speech key a bot uses. See "Pending restart" in
`docs/assistant-gateway.md`.

### Memory

An agent remembers only what it writes down: its conversation gets shortened
(compacted) when it grows long, and older turns are cut. With **Remember
information** on, AgentPier tells the agent to write durable facts and plans to
`MEMORY.md` and day notes to `memory/YYYY-MM-DD.md` as soon as you share them, and
never to say it saved something unless the write succeeded. Before a conversation
is shortened, the agent gets one last chance to append to the day note.

When you press **Summarise now** ([long chats](#what-the-agent-is-doing)), AgentPier
first gives the agent a hidden memory step in that chat, because no automatic last
chance comes before a summary you ask for. See below.

Shortening a long conversation can take a few minutes before the agent answers.
Meanwhile the chat shows **Summarising the conversation so far — this can take a few
minutes for long chats.** instead of **Working**, and the header shows **Summarising
conversation**. Afterwards a quiet line such as **Earlier messages were summarised
(about 251k → 18k tokens).** marks the place in the chat. Both appear only in
AgentPier; nothing is sent to the paired Telegram chat.

Only your own messages (in the chat or the paired Telegram chat) and its routines'
runs can change an agent's memory. Forwarded content, reminders, check-ins and tasks
from a lead agent cannot. When a background command the agent started for one of your
messages (a long render, for example) finishes after its reply, the agent's follow-up
on the result may still change files, memory and granted project folders like that
message did: for up to two hours, and only until a newer message arrives in that chat.
A command started for forwarded content, a reminder or a lead's task stays read-only,
and the command's output never counts as your message. When a write is refused, the chat shows a quiet line such as
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
- **Direct folder access:** under **Allowed projects**, each allowed project offers
  **None**, **Read** or **Read and write** for its folder. With **Read** the agent
  lists, reads and searches files there; with **Read and write** it also creates and
  changes files, without an approval per change. Its instructions name each folder
  with its path and level. `.git` internals, links leading out of the folder and
  AgentPier's own data stay locked, and every change is recorded in the activity log
  with its path and size, never its content
  ([folder access](assistant-workflows.md#direct-folder-access)). The same access can
  be set from the project: **Projects → <project> → Agents**
  ([agent access per project](assistant-workflows.md#agent-access-from-the-project)).
- **GitHub:** **No access**, **Read** or **Read and write** through one of your token
  profiles from **Settings → Access → GitHub connections** (the host's **Default for agents** is
  preselected). The agent gets the official GitHub MCP server with that profile:
  **Read** offers repositories, issues, pull requests and Actions runs read only;
  **Read and write** also comments on and creates issues and pull requests, merges
  pull requests, pushes, changes and deletes files, runs workflows and creates, forks
  and deletes repositories, all without an approval per change. With shell access, `gh` and `git` in the
  agent's commands use the same profile instead of your own login. The token never
  appears in the agent's instructions, files, chat or the browser (with shell access
  the agent runs as you and could read it like you can); a rotated token reaches the
  agent at once, a deleted profile removes the access. Each profile and level runs
  its own GitHub MCP server for every agent session, about 45 MB of memory each. The page warns when a token's known
  scopes lack `repo`, and AgentPier installs the GitHub MCP server on first use
  ([GitHub for agents](assistant-gateway.md#github-for-agents)). Each change is
  recorded in the activity log.
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
- **Team:** **Use team** (**On request**, **Suggest** or **Autonomous**; see
  [when a lead uses its team](#when-a-lead-uses-its-team)), **Allow teams without
  asking each time**, **Team members may use shell and SSH** (off by default; see [teams](#teams-asks-and-tasks) below), **Maximum team size** and
  **Member time limit (minutes)**.
- **Teams:** the agent's active and archived teams and, below them, **Questions and
  tasks** it sent to its members.
- **Shared by the lead agent** (permanent members only): the project folders, coding
  projects, MCP servers and **Read images** the member's lead shares with it, each
  "via <lead>", with
  **Revoke** ([sharing a lead's access](#sharing-a-leads-access-with-permanent-members)).

### Routines & check-ins

**Acting on its own** (check-ins), **Reminders** and **Routines**; see
[routines, reminders and check-ins](#routines-reminders-and-check-ins).

### Telegram

- **Connection:** create a dedicated bot with BotFather, paste its token under
  **Telegram bot token**, choose **Connect Telegram**, then **Pair my private chat**.
  Messages from that chat reach the agent's conversation and are marked "via
  Telegram"; replies go back to Telegram, a long one in full as several messages
  split between paragraphs or lines (beyond about 64,000 characters or 40 messages
  a closing note says the reply was shortened). **Telegram activity** shows deliveries that
  need a decision. Voice messages are transcribed when a Deepgram key is set under
  **Accounts → Services for agents → Speech recognition**. Files the agent shares in
  a Telegram turn reach Telegram too ([files from agents](#files-from-agents)).
- **Telegram for other people:** gives the agent its own bot for people you choose,
  each with a separate conversation. Add each person by numeric Telegram user ID
  under **Allowed people**. The agent never uses shell, local (stdio) MCP servers,
  AgentPier's own tools or session tools for them, so shell must be off, stdio
  servers removed and SSH accesses removed before you connect such a bot. Adding,
  removing or renaming people applies at once while the agent service keeps running;
  connecting a bot needs a restart of the agent service, which then is pending (see
  above); disconnecting a bot, replacing its token or removing the last person
  restarts the agent service after you confirm.

## Teams, asks and tasks

An agent can lead a team. By default it proposes a team and waits: approve or decline
the proposal in its chat or in Telegram. `/team <task>` or **Allow a team for this
message** behind **+** in the composer allows one team for one request; **Allow teams
without asking each time** allows them in general. Temporary members get their own
chat, finish with the task and can be kept with **Keep as permanent agent**.
Permanent members stay under their lead in the sidebar.

A lead can base a member on an Agency agent: it searches the catalog with its team
tools and names an entry as the member's template. The member then gets that
template's instructions instead of the lead's, plus its role and assignment; what it
may use still comes only from the lead's grants. The proposal card and the Telegram
approval name each member's template with a link to its source. A template the scan
warned about always waits for your approval, even when teams are allowed without
asking; a blocked one is refused. The member's **Profile** keeps the template, also
after **Keep as permanent agent**.

Every member row and chat header shows the model the member actually runs on:

- **Temporary members** use the lead's current model unless they have one of their
  own. Change the lead's model and its following temporary members use the new one
  from their next turn on; the member's own Profile revision does not change. A model
  chosen for a temporary member in an earlier AgentPier version is ignored. When the
  lead's model connection is removed or unavailable, they stop working with the same
  hint as the lead until you choose another model for the lead. Switch off **Follow
  the lead's model** in the member's Profile to give it a model of its own; lead
  changes then no longer affect it until you switch it on again.
- **Permanent members** have their own model. A member kept with **Keep as permanent
  agent** takes over the lead's model of that moment; later changes to the lead do not
  affect it. Change it in the member's Profile; its lead can change it too (see
  below). A lead's own assignment is not shown as "changed since taken over".

The lead decides what each temporary member gets, and can only give what it has
itself: web search, web pages, browser, images, skills, its MCP servers, a read-only
copy of its memory, reminders, its project folders (each at most at the lead's own
**Read** or **Read and write** level) and its GitHub access (through the lead's token
profile, at most at the lead's level). Without a choice of the lead a member gets memory,
web search and web pages; so do members from teams that started before grants
existed. The team proposal lists what every member gets. While a member works on
its task, and also after it finished as long as the lead can still ask it questions
or give it tasks (it is not archived or kept as a permanent agent), the lead can
grant it more or take grants back; each change shows on
the team card, as a note in the member's chat and the lead's chat, and in the
member's **Capabilities → Granted by the lead agent**, and it is recorded in the
activity log. Grants follow the lead: if it loses a capability, its members lose it
too. You see a member's project folders, MCP servers, shell and SSH from its lead
next to the shares with permanent members, and can revoke them there
([Sharing a lead's access](#sharing-a-leads-access-with-permanent-members)). A reminder a member sets is created on the lead, listed in the lead's settings
and sent to the lead's Telegram chat. Members never get their lead's team tools or
routines; they only ask each other and report to their lead
([Members talking to each other](#members-talking-to-each-other)).

Every temporary member has its own memory that it can write, always on. The lead's
memory grant adds a read-only copy of the lead's memory beside it (in the member's
`memory/lead/` folder); the member can search both but never writes the lead's. You
can read a member's own memory under **Capabilities → Own memory** in its settings.
When a member is kept as a permanent agent, its own memory stays and the copy of the
lead's is removed.

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
own settings (web and image tools, skills, MCP servers, reminders), but never shell,
SSH, project folder or GitHub access, which you set yourself. It keeps only its own memory, which it can write;
the copy of the lead's memory is removed. Its name and
instructions stay, and it stays under its lead. You can archive it at any time.

A lead also talks to its members directly:

- It can **edit** its temporary members while they work or later, as long as it can
  still reach them, and its permanent members that are not archived: their name, role
  and assignment, additional instructions, or their whole instructions, even ones you
  edited yourself, and their model. It does this on its own initiative. Each change
  shows as a note in the member's and the lead's chats and in the member's
  **Capabilities → Granted by the lead agent** history (for a permanent member in
  its Profile instead), which also keeps, for you only, the instructions the last five
  changes replaced. It takes effect from the member's next turn, also in your own
  chats with a permanent member.
- It can **look up models** to give its members: it lists the models of your usable
  sources (ChatGPT accounts, OpenRouter connections with a key, endpoint connections)
  (a ChatGPT account named just "ChatGPT", never by its e-mail address)
  with context window, output limit, reasoning, image input and, for OpenRouter, the
  price per million input and output tokens (unknown otherwise), and it sees what it
  and its members run on now. It cannot do this in routines. It can name a model per
  new member in a team proposal (shown on the approval card) or move an existing
  member to another model, and it tells you what a model costs when the price is
  known. A temporary member with a model assigned this way, even the lead's own
  current one, keeps it when the lead's model changes. Each model change shows as a note in the lead's chat (and in the
  member's task chat, if it has one), as a history entry with the old and new model
  and in the audit log. If an assigned model stops working, the member's turns fail
  visibly; it does not fall back to another model.

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
  in the message cancel that permission. With **Suggest** or **Autonomous**, a short
  yes to the lead's offer ("yes, go ahead") counts as well; with **Autonomous**, a
  task the lead starts on its own in reply to your message may also write (see
  below), and so may a task from a routine you marked **May write**.
- The turn in which the lead handles a member's result may act on it like the lead's
  own work, whatever the task was allowed: it changes files in the lead's own
  workspace and memory and in the project folders you gave the lead with **Read and
  write**; a coding request from it always waits for your approval. The member's
  answer never counts as your request or approval, so it unlocks nothing else. Each
  such change is recorded in the activity log with the request. When the lead tried
  something that needs your own message, such as an SSH command, the chat shows
  **Go ahead** below its reply: it sends "Yes, go ahead" as your own message, so the
  lead can act in your turn.
- **Work → Teams → Questions and tasks** lists every request, open ones first, marked
  "may write" or "read-only", "self-initiated" when an autonomous lead started it
  on its own and "Scheduled · <name>" when one of its routines did, with **Cancel** for open ones.
  It also lists the members' requests to each other as "<member> → <member> ·
  question" or "· task" ("result to the lead" when the result goes to the lead) and
  their own reports as "Result from <member>" or "Problem from <member>".
- Member reports and answers reach the lead whole up to 65,536 characters. A longer
  one is marked shortened, and the team card or request shows "Shortened" with **Open
  chat**, where the whole text is. When a team's reports together are too long for the
  lead's summary request, the longest are shortened for the lead, which is told that
  the whole reports are in the members' chats.

Check your members' shell levels and MCP servers before you let a lead use them.

### Members talking to each other

Members of the same lead, temporary and permanent, can agree among themselves without
the lead relaying every message, both when the lead's task says so ("agree the story
with Learning") and on their own:

- A member can **ask** a colleague a question and **hand a task** to a permanent
  colleague; temporary colleagues only answer questions. The colleague works in its own
  task chat when it is free, where you can read it, and sees only the question or task,
  "from" the asking member, never that member's chat. The answer comes back to the
  asking member as a separate message ("A colleague's answer arrived. The agent
  continues."), or to the lead when the asking member wants it so or can no longer be
  reached.
- A member can **report** to its lead on its own: a finished result or a problem, with
  up to 10 project files that hold it. The report reaches the lead's main chat as a
  separate message, and the lead acts on it as its **Use team** level allows. A
  member's reports reach the lead one at a time; its routines can report too.
- **Limits:** at most one open request per colleague and direction, one open task per
  colleague, 3 open requests per member and 6 requests per member and hour; at most 6
  reports per member and hour. A refused call tells the member to report to its lead
  instead.
- **One level only:** a member handling a colleague's question or task, or its answer,
  cannot ask or task anyone else, so there are no chains and no ping-pong. Members of
  other leads are never reached.
- **Writing:** questions never write. A colleague's task may change files only when
  the sender's own work may change files: your own message in the sender's chat, a
  lead task that may write, or a routine marked **May write**. Otherwise it runs
  read-only. The receiving member always works with its own tools and access, never
  the sender's grants or shares; a task that a lead task started reaches only the
  lead's standing shares with the receiver, as the lead's own task would. Such a task
  never changes memory, and a coding request from it always waits for your approval.
- **The lead sees everything:** a quiet line in its main chat when an exchange starts
  and when it ends ("Learning asked Head Writer a question", "Head Writer answered
  Learning"), naming only who and how it ended, and each exchange and report under
  **Work → Teams → Questions and tasks**. The lead's "Your team" instructions and
  tools tell it that its members can agree among themselves; name in a task whom to
  involve and where the result goes.

### Sharing a lead's access with permanent members

A permanent member has only the access you gave it. When a task needs the lead's own
access, the lead can share it, without asking you:

- **Project folders** at most at the lead's own **Read** or **Read and write** level,
- **Coding projects**: the member may request coding runs on the lead's project with
  the lead's pipelines; every run still waits for your approval, also when the lead
  may start pipelines without one. The request shows in the member's chat and in the
  lead's chat,
- **MCP servers** bound to the lead (servers with agent folder placeholders get the
  member's own folders),
- **Read images**, so the member can look at the images in the folders it works in,
  only while the lead has **Read images** on itself and only for good (never with
  one task). The member's own **Read images** switch stays as you set it; the shared
  one shows apart from it and ends for good when the lead loses it.

The lead shares either for good (a standing share, through its grant tool) or with
one delegated task, ending with that task. A share counts only while the lead holds
the same access: if the lead's level drops, the member's drops with it at its next
call; if the lead loses the project or server, or the lead or member is archived or
the member is no longer the lead's permanent member, the share ends and is removed.
Shares never change the access you gave the member yourself and are listed apart from
it: in the member's **Work → Shared by the lead agent**, in **Projects → <project> →
Agents → Shared by lead agents** and with the MCP server under **Accounts → MCP
servers**, each "via <lead>" with **Revoke**. Revoking ends the share at once and fails
coding requests that still wait on it. Every share, revocation and change of a
project file through a share is recorded in the activity log with the lead and the
task.

Shared folders and coding projects work in the lead's tasks for the member, in your
own chats with the member and, for standing shares, in the member's own routines (a
task's share stays with its task). A folder the lead shares with **Read and write**
is the lead's own permission: the member may change files there in every task from
that lead, as a temporary member may in its granted folders, never above the lead's
own level at that moment (a read share or a lead lowered to **Read** only reads).
Whether a task may change files in the member's own workspace still depends on the
task (you asked for it, an autonomous lead started it, or a routine marked **May
write** did). In a routine, shared folders change only when that routine is marked
**May write**. Coding requests on a shared project always wait for your approval.
Shell and SSH are never shared this way: a permanent member uses only its own.

The same overviews list what leads granted their temporary members, marked
**Task-bound member**: in the member's **Capabilities → Shared by the lead agent**
(a temporary member has no Work tab), in **Projects → <project> → Agents → Shared by
lead agents** and with the MCP server under **Accounts → MCP servers**. Each project
folder shows the level the member uses now, at most the lead's own; a folder,
server, shell level or SSH the lead does not hold right now is marked **Not in
effect** and stays listed until it is revoked. **Revoke** takes a folder, MCP server,
shell or SSH back as the lead's own revocation would: the member loses it at once (an
MCP server also in the running agent service), a note goes to the member's and the
lead's chat, the activity log records you as the one who revoked it, and a waiting
shell or SSH approval for what you revoked is cancelled. Coding is listed as
**Coding runs through the lead agent** without **Revoke**: a temporary member
requests coding runs on its lead's projects and pipelines while its team works, and
every run waits for your approval. To end it, stop or archive the member, or remove
the project from the lead.

### Routines a lead sets up for its members

A lead can plan recurring work for its permanent members: it sets up, lists,
changes, pauses and removes routines on them with its team tools, without asking you
each time. Temporary members are refused, as they work only on their task.

- Such a routine is the member's own routine: it runs on its schedule with the
  member's own tools and approvals and the folders its lead shares with it for good.
  Its result appears in the member's chat as for any routine and also reaches the
  lead as a report from "<member> · routine <name>", which the lead summarizes for
  you. A failed run is reported once, not again until the routine works again; a
  run whose task says to report only findings stays silent when there are none.
- It only reads unless you switch on **May write** in the member's **Routines &
  check-ins** (only you can) or the lead uses its team **Autonomous**ly.
- The lead sets one up only in reply to your own message. With **On request** that
  message must name the member; with **Suggest** the lead offers it first. Each
  member takes at most 5 routines from its lead, and they run at most every 15
  minutes.
- In the member's **Routines & check-ins** each shows "Created by <lead>". You can
  edit its name and task, pause, remove it and switch **May write** like any
  routine. The lead's reports are listed under **Work → Teams → Questions and
  tasks** as "Routine report from <member>".
- When the member is archived or no longer the lead's permanent member, or the lead
  is archived, its routines are removed and the activity log records why.

### When a lead uses its team

**Work → Team → Use team** sets how the lead involves its members on its own. Each
turn, AgentPier adds a short "Your team" section to the lead's instructions: its
members with name, role and whether they are permanent or temporary, and the rules
for the chosen level:

- **On request:** the lead asks or delegates only when you ask it to, by name, with
  `@` or for a team.
- **Suggest** (the default, also for agents created before this setting existed): when
  a member fits, for example a question in its area or longer research or writing for
  a permanent member, the lead offers it in one sentence and waits. Your yes counts as
  your request when the lead's last reply offered that member, so a task delegated
  after it may change the member's workspace.
- **Autonomous:** the lead asks members and delegates suitable tasks on its own and
  tells you whom it involved. A task it starts on its own in reply to your message may
  change files in the member's own workspace (never its memory) and is marked
  "self-initiated". Its tasks stay read-only when your message says not to change
  anything, when you named the member without asking for the task as described above,
  and in forwarded, scheduled or follow-up turns, including tasks a routine delegates
  unless you marked it **May write**. Shell, SSH, project folders, GitHub and grants beyond the default keep
  their approvals, and a team the lead proposes on its own still waits for you unless
  you asked for one or allowed teams without asking. A lead starts at most 4 questions
  or tasks on its own per turn and 20 per hour; requests you asked for by name do not
  count.

A lead is also told when a member's task chat (the chat you open for the member) grows
long, by the same rule as the hint above (60 % of the context window, else 100,000
tokens): one short message in its main chat. It is told again only after the chat grew
by half again or by 50,000 tokens, or after a summary, and not while a summary after
the member's task is pending. Further chats you opened with a member give the lead no
hint. The lead can then call `agentpier_team_member_summarise` for one of its own
members that are not archived, **now** (refused with a busy answer while the member
works) or **after_task** (starts at once on an idle member, otherwise once the member is
idle and before the lead's next request reaches the chat; dropped when the member is
archived). Both chats get a note, the memory step above applies, and routines cannot use
the tool.

At every level the lead is told not to involve members for trivial requests and to
summarize their answers for you. At every level it is also told that its members can ask each other,
hand each other tasks and report back
([Members talking to each other](#members-talking-to-each-other)).

## Routines, reminders and check-ins

All three live in the agent's **Routines & check-ins** tab and need no Telegram. Their
results go to the agent's main chat (the first chat in AgentPier, the same one a
paired Telegram chat writes into, whatever other chats you started) with a push notification that opens it. With a paired
Telegram chat, **Also send to Telegram** sends a reminder, routine or the check-ins
there too; it is a switch per reminder and routine (also when creating one) and one
for all check-ins. You can also ask the agent in any of your chats, in AgentPier as
well as in Telegram, to send a reminder or routine to Telegram too or to stop that
("send it to Telegram as well"); it switches that reminder or routine to your own
paired chat, never to anyone else's, and asks you to pair Telegram first when you have
no paired chat. Users can pair Telegram only on their own agent with **Extended**
access; on a shared agent or at a lower level the agent tells them Telegram delivery is
not available, and results still reach their chat. Unpairing Telegram only stops that extra delivery; everything keeps
running in the chat. Reminders and routines created before this kept their Telegram
delivery. An agent whose check-ins were switched on but which had no paired Telegram
chat (so it never checked in) starts checking in after the update, in its chat with a
push notification; switch **Check in on its own** off if you do not want that. A check-in
or routine result that also went to the paired Telegram chat sends no push
notification unless a device turned on **Also what Telegram delivered**
([notifications](notifications.md#what-notifies-you)). An agent waiting for an approval
or proposing a team sends an **Agent approval** push notification as well.

- **Reminders** send a one-time or daily text, shown in the chat marked
  "Scheduled · <name>". You can also ask for one in the chat; one asked for in
  Telegram is sent there too.
- **Routines** save a task prompt that runs daily or on an event (an owner request or
  a linked coding run that completed); **Run once** starts one now. A member's lead can
  set routines up for it too ([routines a lead sets up](#routines-a-lead-sets-up-for-its-members)). A routine uses
  the agent's own tools and approvals (memory, its workspace files, web, browser,
  shell and MCP servers, as far as they are switched on) but cannot schedule. It reads
  the agent's project folders (its own and those its lead shares with it for good)
  and changes files there only when you switch on **May write** ("Project folders and
  delegated tasks") in the routine's details, or ask the agent to switch it on or
  off when it creates or changes the routine for you ("this routine may write"). The
  agent does that only on your own message in one of your chats, never from a
  scheduled run, forwarded or tool-provided content, and never for a user's routine
  (users cannot switch it). Otherwise a write attempt is refused and the routine's result says so. Every change
  is recorded in the activity log with the routine. A coding request from a routine
  always waits for your approval in the agent's chat, also when the agent may start
  pipelines without one; a routine cannot cancel coding runs. A lead's routine can ask
  its members and delegate tasks to permanent ones; such a task runs read-only unless
  the routine is marked **May write**, and **Work → Teams → Questions and tasks**
  marks the request "Scheduled · <name>". A marked routine's tasks count as your
  standing instruction and may change files like a task you asked for. Its whole result appears in the agent's chat marked
  "Scheduled · <name>" (and, with Telegram switched on, in the paired chat as several
  messages when it is long); a failed run shows a short line there. You can also ask
  the agent for a routine in the chat. Routines
  read the chat's recent messages, including forwarded ones, and run while nobody
  watches, so with full shell access they act without asking. A routine can run SSH
  commands only on hosts set to **Trusted incl. routines**; on any other host it is
  refused and its result says so.
- **Check in on its own** (under **Acting on its own**) lets the agent look at its
  conversation and notes every hour, every 2 or 4 hours or once a day, within active
  hours, and write only when something needs your attention. A check-in is marked
  "Check-in" in the chat. It needs **Remember information**. Each check-in costs a model
  run.

## Dictation

The microphone next to the send button dictates into the message field: tap it, speak,
and the words appear live; tap again to stop. The text stays in the field for editing
unless **Send dictated messages right away** is on under **Accounts → Services for
agents → Speech recognition**. Dictation uses that Deepgram key and needs HTTPS or
localhost for microphone access; the coding session chat offers the same microphone.
Details and limits: [live dictation](assistant-gateway.md#live-dictation-in-the-chats).

## Chats

Each agent holds several chats. The bar under the chat header shows the open chat's
title; tap it for the **Chats** sheet: **New chat** on top, your main chat first, then
the others newest first, and **Archived chats** at the bottom. **New chat** next to the
title starts an empty chat right away; the earlier one stays in the list. The ⋯ of a
row offers **Rename**, **Archive** and **Delete** (**Delete now** removes the chat and
its transcript). Your main chat is the one reminders, routines, check-ins and Telegram
deliver into: it is renamed only. A new chat is first named after your first message;
once the agent has answered it, the agent's own model gives it a short title of three to
six words in your language. Your own name always wins, and clearing it brings the
generated title back. A chat stays usable however long it sits idle; only
your own **Archive** makes it read-only. An archived chat opens read-only with
**Restore**; a link to a deleted chat (an old push notice's) says "This chat was
deleted." and leads to the main chat. The sidebar lists the open agent's recent chats under it, the main
chat first. Server details:
[Several chats per agent](assistant-gateway.md#several-chats-per-agent).

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

## What the agent is doing

While the agent works on a message, the line under it says what it does now:
"Waiting for the model", "Thinking", "Writing the answer", a running tool such as
"Command · Find the reference images" (the short title the model gave the command), or
"The model did not answer, trying again (2 of 8)". **N steps** below it opens the
turn's steps: each tool call with its state (Running, Done, Failed) and when it
thought. Steps show tool names and short titles only, never commands, web addresses,
image prompts, output or what the agent thought.

When the model stays silent for three minutes while the agent waits for it, the chat
says "No answer from the model for N minutes." with **Stop** and **Try again**. Try
again stops the turn and sends "Please continue where you stopped.", so the agent goes
on from its last finished step. A running command or an approval that waits for you
is not counted as silence. A turn that hears nothing for 15 minutes ends by itself;
the chat then says that the model did not answer in time and offers **Try again**. A
model stream that stops sending ends sooner: OpenClaw retries it after two minutes and
gives up after a few tries.

When a chat grows long (from 60 % of the model's context window, or 100,000 tokens
when the window is unknown), the chat says "This chat is long. After a pause the first
reply takes longer, and older details are easier to miss." while no turn runs.
**Summarise now** has the agent service summarise the chat's history right away. When
the agent may write memory (**Remember information** is on, writing memory is proven
safe, and the agent is not shared), AgentPier first runs a hidden memory step in that
chat: the agent may search its memory and read files; it may write only its own
`MEMORY.md` and `memory/` notes, and every other tool is refused. A write outside
them shows **Memory not saved: before a summary, the agent may change only its own
memory.** If the step fails or stalls, the chat offers no **Try again**. The chat shows **Saving memories
before the summary …** (header: **Saving memories**) while it runs; the step ends after
at most five minutes, like **Stop**. Then the chat shows **Summarising the conversation
so far — this can take a few minutes for long chats.** and afterwards the quiet line **Earlier messages were summarised …**; the chat
stays the same chat, also your main chat with its reminders, routines, check-ins and
Telegram. A message you send meanwhile waits and goes out afterwards, once. A very long
history can take more than ten minutes: the chat then keeps showing the summary as
running and unlocks as soon as the agent service is done. If the summary ends without
a result after that, because it failed, found nothing left to summarise, could not
start, the agent runtime stopped or restarted, or its end could not be confirmed, the
chat says so once it is ready again, until you write your next message. If there is nothing
left to summarise, or the agent service refuses, the chat says so. If the memory step
failed, was refused or ran out of time, the summary still follows and the chat says
**No memories were saved before the summary.**; if the chat is still busy after the
step, the summary is refused and the chat says so next to that note. Shared agents
get no memory step, and nothing of it is sent to Telegram. **Hide**
puts the hint away for this chat; it comes back once the chat grew by half again or by
50,000 tokens, whichever comes first, or once it is long again after its history was
summarised.
An archived chat shows the hint without actions. Server details:
[Live steps and stalled turns](assistant-gateway.md#live-steps-and-stalled-turns).

## When the connection is lost

While AgentPier cannot be reached, the sidebar keeps the last known agents, their team
members and teams, and says "Connection lost. Showing the last known agents." An agent
chat you opened before shows its last loaded messages with "Connection interrupted.
Your draft is preserved; history will refresh when connected." Sending stays off until
the connection is back; the typed text stays in the composer. When AgentPier answers
again, the list and the open chat refresh by themselves, also after a restart that
first refused the event stream. All of this lives only in the open page: a reload or a
logout starts empty, and nothing is stored on the device. A logout, or another user
signing in, also forgets unsent agent drafts.

## Attachments

Choose **+ → Attach file, image or video**, paste or drag files into the agent chat,
also in a team member's chat. A message holds up to five files of at most 10 MB: JPEG,
PNG, WebP, GIF and HEIC images, PDF and text files. Copies are saved in the agent's
workspace so it can read them with its tools. Models that accept images (ChatGPT,
endpoint models that declare it, OpenRouter models whose catalog lists image input)
also see images directly; the composer says when the agent's model cannot. Attachments
are part of host backups only with history and a passphrase, and then encrypted (see
[backups](backups.md#what-a-backup-holds)).

Each agent keeps up to 1 GB or 1000 files in its `attachments/` folder, files the
agent put there itself included. The agent's **Profile** tab shows how much of that it
uses under **Chat attachments**, for example "120 MB of 1 GB · 34 of 1,000 files".
**Clear attachments** deletes everything in the folder after a confirmation, including
videos still uploading and unsent files in the composer. Sent messages keep their text
and name each removed file as no longer available. Files the agent shared with you
(below) are not affected. The clear is recorded in the audit log with the number of
files and bytes removed. If the agent replaced the folder with a link or a file, which
blocks every upload, the section says so, and clearing removes it; the next upload
creates the folder again. What a link pointed to is never touched. An agent that
restricted users chat with has no **Clear attachments**: their files are theirs, and
the owner cannot delete them.

### Videos

Videos can be up to 200 MB each: MP4, MOV (iPhone recordings in HEVC or H.264) and
WebM. On a phone the picker offers your videos next to your photos. A video uploads in
pieces, and the composer shows how far it is; a dropped connection resumes where it
stopped. The chat plays a sent video inline (select play; nothing loads beyond its
first frame and length until then); the download button under it saves the file.

The agent receives the video as a file in its workspace, with its length and size in
pixels, and is told that it cannot watch it. No model sees the video itself: AgentPier
sends no video to the model and extracts no frames. Videos count toward the agent's
1 GB of attachments.

### Files from agents

Every agent, team members included, can hand you a file from its own workspace with
its `agentpier_share_file` tool, for example a report it wrote or a chart it drew. The
file appears in the chat at once as the agent's message: images inline (select one to
open it in the image viewer: close it with ×, Esc, a tap beside the image or a swipe
down; pinch to zoom, download or share from there), videos and audio with the
player inline (a full-screen video keeps its own Done button), every other file as a
chip, with the agent's short caption. Every video, audio and file in the chat, your own
attachments included, has a download button beside its name and size that saves the
whole file without leaving the chat; the players themselves offer no download on an
iPhone. In the home-screen app (iPhone, iPad) a download opens the share sheet instead, so
you can save the file to Files or open it in another app and the app stays where it
was; the same applies to downloads of artifacts, backups, SSH keys and files in the
file explorer. It
stays in the history, also while AgentPier is unreachable. When the turn came from your
paired Telegram chat, the file goes there too, as a photo or as a document. A
routine's run can share files as well, for example a weekly report: they appear in the
agent's chat and, when the routine also sends to Telegram, in its Telegram chat. Images an agent creates with
**Create images** arrive the same way on their own, a moment after its reply, without
the agent sharing them. There is no daily limit on created images; an agent uses reference
images from the web only when it may also read web pages, and with several ChatGPT accounts any
signed-in one may be used for images.

- A team member's file appears in its own chat and in its lead's chat, under the
  member's name; it reaches Telegram when the lead's turn the member works for came
  from Telegram.
- Agents share only regular files of at most 25 MB from their own workspace, or from a
  project folder you granted them (reading it is enough; in your own turns and a team
  member's team turns), never through a symbolic or hard link and never from `.git`
  or AgentPier's own data. AgentPier keeps its own copy outside the workspace, so the
  agent cannot change or remove it.
- Shared copies have their own storage beside your attachments: 1 GB or 2000 files per
  agent, each kept for 90 days. When it is full, the oldest copies go first. **Delete**
  under a shared file removes AgentPier's copy from every chat that shows it; the
  agent's own file stays in its workspace. A copy that is gone leaves its message with
  a note that the file is no longer available.

## Users

**Settings › Access › Users** adds other people who chat with agents. They sign in to
the same AgentPier with their own username and password and see a slim app: **My
agents**, their chats, their agents' settings within their level, and **Account**
(Change password, whether you may read their chats, their devices' notifications,
Sign out). They never see sessions, pipelines, projects or system settings.

- **Add user** asks for a display name, a username and a first password (12 characters
  or more). A user's page offers **Reset password** (signs out all of their devices),
  **Sign-in allowed** (off signs them out and removes their reminders, routines and Telegram bots for good),
  **Owner may read chats** (they see it in their app; it applies from now on, never to
  older chats), their agents with a level each (**Chat only**, **Personalize**,
  **Extended**), **Add agent for this person**, **Add to a shared agent** and **Delete
  user** (choose whether their own agents are archived or kept under your account;
  their private chats go unless you may read them).
- An agent of users is **own** (one user) or **shared** (several users, each with their
  own chats; memory, profile (USER.md) and browser are shared, and their chat says so).
  Create one from **New agent** with **For** set to the person. On the agents page and
  in the sidebar they appear under **Agents of users**. You open your own chat with a
  shared agent (**Open my chat**), never a user's; a user's own agent opens its
  settings, where its notes and browser stay hidden until you may read them and then
  show read-only; its reminders and routines are the user's. A user's chat you may
  read shows read-only, without composer, **New chat**
  or chat actions.
- Their **Capabilities** and **Work** tabs show "Locked for agents of users: they
  cannot run programs on this computer." instead of shell, the visible browser window
  (their browser runs headless), SSH, GitHub, pipelines, coding and teams. Their
  **Telegram** tab shows **Telegram for other people** as locked; on a user's own agent
  it offers no bot of yours either and says its user connects its bot in their app.
  **Work › Projects**, a project's **Agents** section and **Add folder** offer
  project folders only, **Read** or **Read and write**, never coding. **Profile › Users of this agent** sets each user's level and, on a
  user's own agent, the **Released capabilities** an Extended user may switch; a shared
  agent's capabilities stay yours.
- In the user's app, **Personalize** edits name, picture (an emoji) and personality and
  instructions of their own agent, and their reminders and notes; **Extended** adds the
  released capabilities and Telegram (after **Disconnect** they may connect the same
  bot again or another one). A shared agent stays yours at every level. Users
  watch and take over their own agent's browser, a shared agent's only while one of
  their chats drives it.

The [Users](users.md) guide covers users as a whole: levels, privacy, sign-in from the
home network or tailnet, deletion and backups.

Server details: [Agents of restricted users](assistant-gateway.md#agents-of-restricted-users)
and [Private chats of restricted users](assistant-gateway.md#private-chats-of-restricted-users).

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
- Agents of restricted users run under a hard lock: no shell, SSH, Git or GitHub,
  coding, teams or OpenClaw session tools (which would reach the agent's other chats,
  on a shared agent the other users'), and no visible browser window. You can give
  them project folders (files only) and MCP servers you registered. Local (stdio)
  servers run commands on the host for those users too, so bind them only where you
  would accept that. With **Read and write** such an agent never changes tool
  configuration in the folder (`.claude/`, `.codex/`, `.opencode/`, `opencode.json`,
  `.vscode/`, `.mcp.json`, `.envrc`, `mise.toml`, Git hook managers and similar) or the instruction
  files your coding CLIs load (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`), but it can change any other file, including
  scripts, `package.json` or Makefiles that you or your coding sessions run later.
  Give write access only to folders whose content you do not run unchecked. See
  [Agents of restricted users](assistant-gateway.md#agents-of-restricted-users).
- A restricted user's chats are private. You read them, and her own agent's memory,
  files and browser, only after you switch on **Owner may read chats** for her. Chats
  count from that moment on; her own agent's memory, files and browser become readable
  in full, older entries included. You only watch her agent's browser: its live view
  offers no **Take over**, start, tab choice or follow. She sees that it is on, in her
  chats and in her agent's browser view. On a shared agent you see its
  settings and shared memory, never other users' chats. See
  [Private chats of restricted users](assistant-gateway.md#private-chats-of-restricted-users).
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
