# Agent workflows

AgentPier reuses existing project memory and coding pipelines. OpenClaw remains
responsible for personal memory, scheduled execution and routine history. This
slice adds explicit project access, action approvals and links between those
existing systems. Gmail, Microsoft 365, Google Calendar, Apple integrations and
sandbox decisions remain deferred.

## Project access and actions

In the agent's settings, **Work → Projects and coding tasks**, select registered
projects and pipelines, then save. All agents, including permanent team members,
start with empty project access. In their team turns, team members can only
request coding tasks on their parent's access (see below). Project access
permits searching and reading that project's existing memory.
Personal OpenClaw notes remain independent.

Enable memory change proposals to let an agent suggest exact titles/content.
Every write requires approval, including when coding has standing permission.
Updates carry the expected memory revision; an intervening edit fails instead of
being overwritten. Stored provenance identifies the proposing agent and action.

Coding starts use selected existing pipelines and their configured accounts.
By default each proposal requires approval. Standing permission permits starting
the selected pipelines without another approval. The separate publishing setting
permits a pipeline with a publish node; it does not add publishing to a pipeline.
Saving captures pipeline/profile definitions and their account references. After
changing a pipeline or profile, save project access again. A changed access
revision invalidates pending proposals; ask the agent for a new proposal.

Project access never follows a project to another entry. When you merge an older
project entry (**Projects → Merge older entry**) or a folder's `git init` moves its
project to the Git identity, the older project leaves every agent's access, its
proposals that were not started yet fail with "Access or pipeline changed since the
request. Nothing was started.", and each changed agent is audited as
`assistant.updated` (`kind: "project-rebind"`). Proposals for other projects stay
valid; SSH command approvals follow their host's SSH access instead. Grant the
remaining project again if the agent should keep working on it. A `git init` move
made while agents were switched off finishes when the agents are back and the project
is used again. After a merge made while agents were switched off, saving **Work**
cleans up: it drops granted projects that no longer exist and says how many it removed; both
`PUT /api/assistants/:id/work` and `PUT /api/assistants/:id/access` list them in
`removedProjectIds`.

Ask the agent to inspect project knowledge or propose a concrete coding task.
The workspace tool first discovers the granted project/pipeline IDs. Approval
shows the project, pipeline, exact task and optional base branch, or the exact
memory change. Owner decisions are available in the agent's settings (**Work → Actions and coding
tasks**) and in its chat; Telegram-origin
proposals also have approval buttons bound to the original channel/chat/user.
Approvals expire after 24 hours. When a project knowledge change is declined,
expires or fails, AgentPier sends the requesting agent's conversation one attributed
follow-up turn saying it was not saved, so the agent does not keep believing it was
stored. The model cannot grant itself access or accept
human review gates inside pipelines. Forwarded Telegram messages are quoted data
and cannot invoke workspace, reminder or routine tools as owner instructions.

## Direct folder access

Under **Work → Allowed projects**, each allowed project has **Direct folder access**:
**None** (the default), **Read** or **Read and write**. The level belongs to the
project grant: removing the project, or a merge that drops it, removes its level too.
The agent's instructions list every granted folder with its project ID, path and
level, and the workspace tool's `catalog` names them as well.

The agent uses the folder through `agentpier_workspace`: `files_list`, `file_read`
(by line `offset`/`limit`), `files_search` (a literal text) with **Read**, and
`file_write` (a whole file, at most 64 KiB; with `append: true` added to the end, so a
larger file is written in parts) and `file_edit` (an exact text that occurs once, or
`replaceAll`) with **Read and write**. AgentPier performs every operation
itself; OpenClaw's own `read`, `write` and `edit` tools stay confined to the
agent's workspace (`tools.fs.workspaceOnly`), because widening them would also let
outgoing media read any file on the host.

- **Who:** the owner's own turns (in AgentPier or the paired Telegram chat) and a
  task member's team turns, never forwarded content, reminders, check-ins or
  routines.
- **Paths:** relative to the project folder or absolute inside it. Every call
  resolves the real path again: `..`, `~`, URL forms, control characters and
  backslashes are refused, links may point anywhere inside the folder but never out
  of it, and `.git` (in any spelling, also through a link) is never read or written.
  AgentPier's own data directory is refused even when it lies inside a project.
  Pipeline run checkouts (`.agentpier-worktrees`) can be read but not changed.
- **Writes:** go to a temporary file beside the target and replace it by rename. A
  link inside the folder is resolved first, so the write lands at its real target;
  only a dangling link is left at the target name, and the rename replaces that link
  instead of creating whatever it points to. Files with a second hard link, FIFOs and
  other special files are refused for reading and writing. Edits and appends change
  only valid UTF-8 files (`PROJECT_FILE_ENCODING` otherwise), so a Latin-1 file is
  never rewritten with replacement characters; reading stays lenient. Changes need
  the running Gateway's proven tool guard (the same condition as native writes) and
  are refused with `PROJECT_WRITE_UNAVAILABLE` before it reports. The path checks and
  the write are separate steps: a process that can already change the folder, such
  as an agent with shell, could swap a folder for a link in between. AgentPier does
  not defend against that race.
- **Audit:** each change is one `assistant.updated` record (`kind: "project-file"`)
  with the project, the relative path, `fileChange` (`create`, `replace`, `edit` or
  `append`), the size in bytes and, for a member, its member ID; never the content.
  The tool call and its result stay in the agent's chat history.
- **Limits:** 2,000 lines per read. Files up to 1 MiB are read whole; larger ones by
  line range (`totalLines` is then unknown), scanning at most 256 MiB per call.
  Edits work on files up to 1 MiB, appends keep a file at most 16 MiB, and one write
  carries at most 64 KiB (`PROJECT_WRITE_TOO_LARGE`; a call above the bridge's
  128 KiB request limit reads `REQUEST_TOO_LARGE`). Search skips `.git`,
  `node_modules` and run checkouts, follows no links, sniffs the first 8 KiB of every
  file and skips binaries and files over 1 MiB, and stops after 5,000 files, 32 MiB
  read or 200 matches.

A lead passes folder access to its task members with `projects` in its grants
(`{ "<projectId>": "read" | "write" }`), at most at its own level, visibly and without
your approval like its other grants. What a member uses is resolved on every call:
when the lead drops to **Read** or loses the project, the member does too. The
member's **Capabilities → Granted by the lead agent** shows the levels it has now. A member
kept as a permanent agent keeps no folder access its lead granted; grant it yourself
in its **Work** tab.

## Agent access from the project

**Projects → <project> → Agents** shows the same access from the project's side.
Every permanent agent that is not archived is listed with **May start coding sessions
in this project** (the project grant: project memory and coding tasks on the
pipelines allowed in the agent's **Work** tab) and **Folder access** (**None**,
**Read**, **Read and write**). A change saves at once through the Work tab's own save
(`PUT /api/assistant-project-access/<projectId>/<agentId>`, which calls the same
`saveWork`): the same validation, revision, audit (`kind: "project-grants"` with the
added and removed projects and changed folder levels, also for Work tab saves) and
instruction refresh, so both views always agree. Choosing a folder level grants the
project; removing the grant removes the level.

Only this project's entries change. The request names what the page showed for the
project (`expected`); if the agent's access to it changed elsewhere since then, the
page reloads that agent and says so. Unrelated changes, for example the agent's
pipelines saved in its Work tab meanwhile, are kept. A Work tab draft opened before a
change from the project gets the usual conflict notice on save.

Team members are not editable here. A read-only list shows the task members that use
the folder through their lead, at the level they have right now (at most the lead's).

**Add folder** offers the permanent agents with **No access**, **Coding only**,
**Coding and read folder** or **Coding, read and write folder**; the choice is applied
right after the project is registered. If an agent's access cannot be set, the project
is still added and the dialog says to set it in the **Agents** tab.

### Coding requests from team members

In a team turn, a team member (temporary or permanent) may request a coding
task, and follow its status, for a project and pipeline its parent agent
currently has access to. AgentPier
identifies the member from the runtime session, never from the model's input,
and records the request as made by that member on behalf of the parent within its
team. Other projects are refused without creating a request. In team turns
members cannot search, read or change project memory or cancel runs; temporary
members also have no reminder, routine or personal memory tools.

A member's request always waits for your exact approval, even when the parent
has standing permission to start pipelines. It appears in the parent's actions,
in the parent's chat until decided, in the team's card under the parent's
agent settings → **Work → Teams** and, when a Telegram chat is bound (the chat that started
the team, otherwise the parent's paired chat), as a Telegram
approval linking to the team task. Telegram decisions must come from exactly
that chat and user. Before the start AgentPier checks the parent's access and
pipeline definition again; a change since the request fails the action with
`GRANT_REVOKED` and nothing is started. Restarts recover a started run from its
durable receipt as for the parent's own requests.

Stopping the team, or the requesting member, withdraws its pending requests
(declined with `TEAM_STOPPED`, audited); they can no longer be approved.

When the run finishes, its result is handed once to the requesting member's
chat as attributed data that cannot authorize further actions. A request that
awaits approval, has an uncertain outcome or is still running does not hold the
team open: the team result lists it as still pending, and once the request
reaches any final state (its run ended, or it was declined, expired, revoked with
`GRANT_REVOKED` or reviewed as unknown) the parent's chat receives the outcome as
a follow-up. Member runs do not trigger the parent's `coding.completed` routines.

Actions display their linked pipeline, progress, human review steps and artifacts.
The existing pipeline detail page remains the place for human review and artifact
inspection. Agents can inspect and cancel their own linked runs within current
project access. Telegram receives durable start, human-review and completion
notifications. Changed pairing cannot redirect an old action's notifications.

Pipeline starts use the existing durable MCP start registry with the action ID.
Lost acknowledgements and process restarts recover the existing run; they never
silently retry a start. Unknown outcomes remain visible and block runtime update
activation. Inspect the pipeline or project memory before marking an outcome as
checked. This closes the notice without retrying or cancelling external work.
Failure to inspect one action does not prevent independent actions progressing.

## Native routines and events

Enable Telegram reminders and pair a private chat for that agent. In its settings,
create a routine with a name, saved prompt and one of these triggers:

- A single timestamp, entered in the browser's local timezone.
- A cron expression with an explicit IANA timezone.
- A manual event or a linked coding task completing successfully.

A reminder repeats prescribed text and runs without tools. A routine asks the
configured model to answer its saved prompt each time, with the agent's own chat
tools: memory search, reading and writing its own workspace files, web
search/fetch, browser and image reading, shell and MCP servers, as far as the agent
has them switched on. Shell approvals work as in chat: an approval requested by a
routine run appears in the agent's chat and in the routine's Telegram chat.

A routine is standing work its owner configured, so the write guard admits a
routine run as its own origin (`TeamBridge.routineWrite`): only the run session of
a bound, enabled routine of the calling agent with memory and routines switched on
may change that agent's workspace, under the same workspace and instruction-file
limits as an owner turn. It is not owner text: it never makes a delegated task
writable (owner proof stays owner-text only), and reminder and check-in runs,
forwarded and tool-provided content still never write. After a Gateway start the
routine's agent regains `write` and `edit` after the write guard is reported and
the Gateway is ready, without a chat turn (see the write guard handshake in
[the Gateway guide](assistant-gateway.md#security-boundaries)).

Accepted risk: a routine run reads the paired conversation's recent turns
(OpenClaw prepends up to ten short user and assistant lines as "Recent
conversation"), and those may include forwarded Telegram text, member results or
answers built from web content. A run with write or shell rights may therefore act
on instructions planted there. An owner chat turn sees the same history with the
same rights; the difference is that nobody watches a routine run as it happens.
Owners who give an agent with routines shell "Full access" or memory (which brings
file writes) should keep that in mind; shell "Approval" still asks before every command.

A routine run never gets the reminder and routine tools (no self-scheduling).
Known limitation: it does not get the team and workspace tools either, so it
cannot ask or delegate to members, start coding jobs or write project knowledge.
The bridge serves those tools only within an owner's chat turn (an AgentPier
attempt for the session), which a routine's own run session does not have. The run cap is the
fixed list `routineTools` (`server/features/assistants/native-capabilities.js`);
OpenClaw intersects it with the agent's `tools.allow`, so capability, shell and MCP
changes apply to routines without rewriting their jobs.

Each run has full context (`lightContext: false`, 300 s timeout) and runs detached
from the conversation of the paired Telegram chat (`sessionTarget: "current"`, as
check-ins do), so it never interrupts a running turn. OpenClaw commits the result
into that conversation once no turn runs there: the AgentPier chat shows it with a
"Scheduled · <routine>" badge and a later turn can refer to it. The result also goes
to Telegram, split into several messages when it is long. OpenClaw's completion
webhook carries at most 2,000 characters of the result (its run `summary`, cut with
"…"); for a cut summary AgentPier reads the whole reply from the job's session
(`chat.history` on `agent:<agent>:cron:<job>`, accepted only while that session is
still the reported run and the reply begins with the summary), otherwise the summary
is all there is. Reminders and check-ins are completed the same way. The chat shows
a longer result whole like any other long message (see the agent chat history in
`assistant-gateway.md`) and still carries its badge; Telegram gets it whole. A
failed run shows as a quiet line in the chat; a result that OpenClaw
could not commit is still shown there from AgentPier's own record. On every Gateway
start AgentPier migrates existing routine jobs to these settings in place
(`NativeRoutines.reconcile`); reminders keep their tool-less isolated jobs.

A completion event triggers the saved prompt; it does not automatically insert
repository content or the coding result. Include only context appropriate for
that routine in the saved prompt.

OpenClaw owns schedules, execution and native run history. AgentPier stores the
original delivery binding and event receipts, and uses its existing Telegram
outbox. Event routines are disabled native jobs triggered explicitly with
`cron.run`; enabling an event binding never enables a periodic native schedule.
Repeated event IDs do not rerun a job. An uncertain event acknowledgement is not
automatically replayed. Manual event delivery accepts a stable caller event ID.

Pausing/removing or disabling reminders prevents new bound delivery. Re-enabling
the capability does not silently resume paused routines. Native history and
Telegram acknowledgement are separate: a successful model run does not guarantee
Telegram delivery. The model connection and host must be available.

## Operations and qualification boundaries

See [managed runtime updates](assistant-runtime-updates.md) for staging, activation,
backup and recovery, and [model connections](assistant-model-connections.md) for
supported endpoint/authentication adapters and credential changes.

The native contracts use the pinned runtime in disposable state with simulated
HTTP models and Telegram transports. They validate integration behavior without
executing real user projects or sending personal test messages. The deeper
[release qualification](assistant-release-qualification.md) covers native memory
deletion/model switching, DST/downtime behavior, one adjacent runtime upgrade and
rollback, and main's project identity changes. Actual vendor availability, local
model tool quality, other runtime version pairs and other native platforms remain
separate qualification areas. Existing personal reminders have been confirmed by
the owner.

Isolated real PipelineEngine tests also cover durable recovery, restart/artifact
linkage, cancellation and revoked access. No user repository was executed for these
tests. See the qualification record for the final branch validation and remaining
release limits.
