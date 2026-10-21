# AgentPier

AgentPier is a self-hosted workspace that hosts native coding CLI sessions on one
machine and makes them usable from a browser, including from a phone. This glossary
fixes the vocabulary the codebase and the user interface share.

## Language

### Sessions

**Session**:
One native coding CLI process, owned by an account and bound to a project directory,
running under AgentPier's private tmux server.
_Avoid_: Conversation, chat, instance.

**Launch description**:
The command, arguments and environment that a session will be started with, built by
a chain of launch adapters before the session is created.
_Avoid_: Launch config, spawn spec.

**Launch adapter**:
A step in that chain. Each one receives the launch description so far and returns it
with its own additions.
_Avoid_: Middleware, plugin, hook.

**Launch mode**:
The variant a CLI is started in, such as a work session or a login session.
_Avoid_: Session type.

**Terminal history**:
The earlier output of a session that tmux retains beyond the visible screen. It lives
in tmux, not in the browser terminal, and is reached by scrolling the session.
_Avoid_: Scrollback, buffer.

### Confinement

The word _sandbox_ is load-bearing and ambiguous in this project. Never write it
unqualified; always use one of the three terms below.

**Sandboxed session**:
A session whose CLI runs inside nono, an external capability-based sandbox.
Sandboxing is opt-in per session and is not the default.
_Avoid_: Secure session, isolated session, jailed session.

**Sandbox profile**:
The nono capability policy a sandboxed session runs under, selected by name. This is
nono's own vocabulary and matches what `nono profile list` reports.
_Avoid_: Policy, profile (unqualified), ruleset.

**Codex sandbox mode**:
The operating-system confinement Codex applies to itself, independent of nono and
present whether or not a session is sandboxed.
_Avoid_: Sandbox (unqualified).

**Grant**:
A single filesystem or network capability a sandboxed session needs in order for one
AgentPier integration to keep working. Adapters declare their own grants.
_Avoid_: Permission, allowance, rule, exception.

### Agents

**Agent**:
A persistent assistant run by the managed OpenClaw service, with its own chat, notes,
capabilities and tools. The UI says "agent"; code, routes and older design documents
say "assistant" for the same thing.
_Avoid_: Assistant (in UI text), bot, persona.

**Agent service**:
The one managed OpenClaw Gateway process that runs all agents on a host. "Gateway" is
OpenClaw's own name for it and appears in design documents and code.
_Avoid_: Runtime (for the process), daemon.

**Team**:
The members one agent works with on a task. A team belongs to its lead.
_Avoid_: Crew, group, swarm.

**Lead**:
The agent that owns a team and sends its members questions and tasks.
_Avoid_: Parent (in UI text), manager, orchestrator.

**Member**:
An agent that belongs to a lead's team. A _temporary member_ is created for one task
and finishes with it; a _permanent member_ was kept with "Keep as permanent agent"
and stays nested under its lead.
_Avoid_: Subagent, child, worker.

**Ask**, **Task**:
The two kinds of lead request. An ask is a question to any member and never writes
files; a task is work delegated to a permanent member and may write only with the
owner's explicit request in the same message, as a self-initiated task of an
autonomous lead, or from a routine the owner marked "May write".
_Avoid_: Job, ticket, delegation (for the record itself).

**Lead share**:
Access a lead passes on to one of its permanent members: project folders, coding
projects or MCP servers it holds itself, standing or for one task, never above what
the lead holds now. A write share changes files in every task of that lead. Kept
apart from the access the owner gives the member and shown "via <lead>". A temporary
member gets a _grant_ instead.
_Avoid_: Inheritance (in UI text), delegation of rights.

**Team usage**:
How a lead involves its members on its own: _on request_, _suggest_ (offers a member
and waits for the owner's yes) or _autonomous_ (asks and delegates itself, within a
per-turn and hourly limit). Shown as "Use team".
_Avoid_: Team mode, autopilot.

**Template**:
An Agency agent (from msitarzewski/agency-agents) an owner creates an agent from, or
a lead names for a team member: its description and instructions, with source,
revision and MIT attribution, never its model or tools.
_Avoid_: Persona, preset, blueprint.

**Routine**:
A saved task prompt that runs daily or on an event and reports to the agent's chat
and paired Telegram chat. It reads the agent's project folders; only a routine the
owner marked "May write" changes files there and delegates tasks that may write. A
lead can set one up on its permanent member: it runs as the member's routine, reports
back to the lead and writes only with "May write" or an autonomous lead.
_Avoid_: Cron job, schedule (unqualified).

**Reminder**:
A one-time or daily text the agent sends to its paired Telegram chat.
_Avoid_: Notification, alarm.

**Check-in**:
An optional scheduled look at the agent's conversation and notes, after which it
writes only when something needs the owner's attention.
_Avoid_: Heartbeat (in UI text), ping.

**MCP server binding**:
The link between one central MCP server and an agent or a coding CLI that receives it.
_Avoid_: MCP integration, MCP assignment.

**Agent placeholder**:
`{agent.workspace}` or `{agent.attachments}` in a local MCP server's settings,
arguments or working directory, resolved to each bound agent's own folder when the
server is compiled once per agent.
_Avoid_: Variable, template, path macro.

**Skill**:
Always qualify it. A _CLI skill_ is a shared `SKILL.md` for the coding CLIs, managed
under Extensions. An _agent skill_ is a skill bundled with OpenClaw that the owner
switches on per agent under Capabilities.
_Avoid_: Skill (unqualified), plugin, tool.

### Users

**Owner**:
The one person who set up AgentPier and holds its workspace: sessions, projects,
accounts, settings and agents.
_Avoid_: Admin, root.

**User**:
A person the owner adds who signs in with her own password and reaches only her own
app (`/api/me`): her agents and her chats. German copy says "Benutzer".
_Avoid_: Member (that is a team member), guest, account.

**Own agent**:
An agent that serves exactly one user; its memory, files and browser are hers.
_Avoid_: Private agent, personal agent.

**Shared agent**:
An agent that serves several users, each with her own private chats, sharing one
memory, profile and browser.
_Avoid_: Public agent, group agent.

**Level**:
How much a user may change on an agent: **Chat only**, **Personalize** or **Extended**.
_Avoid_: Role (the principal's role is owner or user), permission.

**Owner may read chats**:
The per-user opt-in that lets the owner read her chats from its start on, and her own
agent's memory and files in full.
_Avoid_: Monitoring, supervision.

**Principal**:
Who a request acts for, derived from its session cookie: `{ role: "owner" }` or
`{ role: "user", userId }`.
_Avoid_: Identity (that is the service that resolves it), actor.

### Profiles

_Profile_ is also ambiguous. Four unrelated things carry the name, so qualify every
use.

**Account profile**:
The isolated configuration directory that holds one account's CLI credentials and
settings.
_Avoid_: Profile (unqualified), CLI config.

**Task profile**:
The reusable CLI and model configuration a pipeline stage runs with.
_Avoid_: Profile (unqualified), stage config.

**Extension profile**:
A named selection of shared CLI skills, plugins, marketplaces and Agency agents. MCP
servers for the coding CLIs are managed centrally, not per extension profile.
_Avoid_: Profile (unqualified), plugin set.

**Sandbox profile**:
See above. Belongs to nono, not to AgentPier.
