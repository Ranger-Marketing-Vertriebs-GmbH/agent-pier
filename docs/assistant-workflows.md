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
`removedProjectIds`. A granted pipeline that was deleted later likewise leaves the grant
with the next save, from **Work** or from the project, instead of blocking it; a
pipeline newly selected that does not exist is still refused.

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
(by line `offset`/`limit`), `files_search` (a literal text), `image_view` with
**Read**, and
`file_write` (a whole file, at most 64 KiB; with `append: true` added to the end, so a
larger file is written in parts) and `file_edit` (an exact text that occurs once, or
`replaceAll`) with **Read and write**. AgentPier performs every operation
itself; OpenClaw's own `read`, `write` and `edit` tools stay confined to the
agent's workspace (`tools.fs.workspaceOnly`), because widening them would also let
outgoing media read any file on the host. With **Read**, `agentpier_share_file` and
its `projectId` hand the owner a file from the folder in the chat (see
[files from agents](agents.md#files-from-agents)).

`image_view` shows the agent one PNG, JPEG, GIF or WebP file of the folder, up to
6 MiB, as an image the model sees: `file_read` refuses binary files
(`PROJECT_FILE_UNSUITABLE`, whose reason points images to `image_view`), and
OpenClaw's own `view_image` stays in the agent's workspace. The path is resolved like
every read (no `.git`, no links leading out, no hard links, never AgentPier's data);
the type comes from the file's bytes, as for uploaded chat images, and other files are
refused with `PROJECT_IMAGE_UNSUITABLE`. It needs the viewing agent's own **Read
images** (for a task member the lead's grant, for a permanent member its own switch or
its lead's share, see [agents](agents.md#sharing-a-leads-access-with-permanent-members))
(`IMAGES_OFF` otherwise) and a model that takes images (`MODEL_TEXT_ONLY`; a
connection AgentPier cannot judge is left to the runtime, as for chat uploads). Each
view is audited with its path and size, like a change.

- **Who:** the owner's own turns (in AgentPier or the paired Telegram chat), a
  task member's team turns, a lead's tasks for a permanent member (with what the
  lead shares; a write share changes files in every task of that lead, capped at the
  lead's own level), a lead's own follow-up on its member's result (its own folders
  only, never shares) and the agent's own routine runs, never forwarded content,
  reminders or check-ins. A routine reads the agent's folders and its lead's standing
  shares and changes files only when the owner marked it **May write** (for a
  routine the member's lead set up, also while the lead uses its team
  **Autonomous**ly); otherwise `ROUTINE_READ_ONLY`.
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

A lead can also share its folders and coding projects with its permanent members,
standing or for one delegated task, apart from the access you give them; in a task
from the lead only those shares count, and files change only in a task that may
change files. Coding requests on a shared project always wait for your approval and
run on the lead's grant. You see and revoke each share in the member's **Work →
Shared by the lead agent** and in the project's Agents section
([sharing a lead's access](agents.md#sharing-a-leads-access-with-permanent-members)).

## Agent access from the project

**Projects → <project> → Agents** shows the same access from the project's side.
Every permanent agent that is not archived is listed with **May start coding sessions
in this project** (the project grant: project memory and coding tasks on the
pipelines allowed in the agent's **Work** tab) and **Folder access** (**None**,
**Read**, **Read and write**). A change saves at once through the Work tab's own save
(`PUT /api/assistant-project-access/<projectId>/<agentId>`, which calls the same
`saveWork`): the same validation, revision, audit (`kind: "project-grants"` with the
added and removed projects and changed folder levels, also for Work tab saves) and
instruction refresh, so both views always agree. For an owner agent, choosing a folder
level grants the project and removing the grant removes the level. An agent of a
restricted user holds folder levels without the project grant (files only): its
`coding: false` request keeps the chosen level, and `coding: true` answers 409
`USER_AGENT_LOCKED`. Its writes never reach tool configuration such as `.claude/`,
`opencode.json`, `.vscode/`, `.mcp.json`, `.envrc` or instruction files such as `AGENTS.md` (403 `PROJECT_TOOL_CONFIG_LOCKED`; see
[Agents of restricted users](assistant-gateway.md#agents-of-restricted-users)).

Only this project's entries change. The request names what the page showed for the
project (`expected`); if the agent's access to it changed elsewhere since then, the
page reloads that agent and says so. Unrelated changes, for example the agent's
pipelines saved in its Work tab meanwhile, are kept. A Work tab draft opened before a
change from the project gets the usual conflict notice on save.

Team members are not editable here. **Shared by lead agents** lists the permanent
members a lead shares this project with, "via <lead>", with what applies now (folder
level, coding, standing or for one task) and **Revoke** (`shared` in the Agents view,
`DELETE /api/assistant-lead-shares/:id`). The same section lists the folders leads
granted their temporary members, marked **Task-bound member**, at the level the member
has right now (at most the lead's), with **Revoke**, and their coding through the lead
for information (`memberGrants` in the Agents view; `GET /api/assistant-lead-shares`
returns them as `memberGrants` beside `shares`, and their ids, `task:<member>:<kind>…`,
revoke through the same `DELETE` route). The older read-only `members` list is still
returned for existing clients.

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

Enable **Allow reminders and routines** for that agent; no Telegram chat is needed.
Under **Routines & check-ins** in its settings (or by asking the agent in its chat),
create a routine with a name, saved prompt and one of these triggers:

- A single timestamp, entered in the browser's local timezone.
- A cron expression with an explicit IANA timezone.
- A manual event or a linked coding task completing successfully.

Asked in any of your chats, the agent can also switch **Also send to Telegram** for
its reminders and routines; it uses your own paired Telegram chat and asks you to
pair one first when there is none (users can pair only on their own agent with
**Extended** access).

Asked by the owner in one of his chats, the agent can likewise switch **May write**
on or off when it creates or changes one of its routines; its unattended runs may
then change files in its project folders and delegate tasks that change members'
files. Scheduled runs, forwarded or tool-provided content and users' requests never
switch it.

A reminder repeats prescribed text and runs without tools. A routine asks the
configured model to answer its saved prompt each time, with the agent's own chat
tools: memory search, reading and writing its own workspace files, web
search/fetch, browser and image reading, shell and MCP servers, as far as the agent
has them switched on. Shell approvals work as in chat: an approval requested by a
routine run appears in the agent's chat and, when the routine also sends to Telegram,
in its Telegram chat.

A routine is standing work its owner configured, so the write guard admits a
routine run as its own origin (`TeamBridge.routineWrite`): only the run session of
a bound, enabled routine of the calling agent with memory and routines switched on
may change that agent's workspace, under the same workspace and instruction-file
limits as an owner turn. It is not owner text: it never makes a delegated task
writable on its own (owner proof stays owner-text only); only a routine the owner
marked **May write** in its details starts tasks that may write,
recorded as the owner's standing instruction. Reminder and check-in runs,
forwarded and tool-provided content still never write. After a Gateway start the
routine's agent regains `write` and `edit` after the write guard is reported and
the Gateway is ready, without a chat turn (see the write guard handshake in
[the Gateway guide](assistant-gateway.md#security-boundaries)).

Accepted risk: a routine run reads the main chat's recent turns
(OpenClaw prepends up to ten short user and assistant lines as "Recent
conversation"), and those may include forwarded Telegram text, member results or
answers built from web content. A run with write or shell rights may therefore act
on instructions planted there. An owner chat turn sees the same history with the
same rights; the difference is that nobody watches a routine run as it happens.
Owners who give an agent with routines shell "Full access" or memory (which brings
file writes) should keep that in mind; shell "Approval" still asks before every command.

A routine run never gets the reminder and routine tools (no self-scheduling).
A lead's routine may list, ask and delegate to its own members
(`agentpier_team_members`, `_ask`, `_delegate`, `routineTeamTools`): the bridge
binds such a call to the routine's run session (`TeamBridge.routineRun`) and the
request carries the routine as its origin (`{ kind: "routine", bindingId, name }`,
`LeadRequestStore.caller`). `agentpier_workspace` serves a routine run as well
(`workspace-calls.js` `routineContext`, the binding read live on every step): the
agent's own project folders and its lead's standing shares, never a task's share;
reads always, changes only with the routine's **May write** (`routineWrites`,
otherwise `ROUTINE_READ_ONLY`), audited with `origin: "routine"` and the
`routineId`. Coding requests and project knowledge proposals always wait for the
owner (shown in the agent's chat, stored with the `routineId`); `coding_cancel` is
refused. Every other team tool stays out, so a routine cannot propose teams or
archive and grant members; the bridge serves those only within an owner's chat turn
(an AgentPier attempt for the session). The run cap is the
fixed list `routineTools` (`server/features/assistants/native-capabilities.js`);
OpenClaw intersects it with the agent's `tools.allow`, so capability, shell and MCP
changes apply to routines without rewriting their jobs.

Each run has full context (`lightContext: false`, 300 s timeout) and runs detached
from the agent's main chat (the person's main AgentPier conversation, which a paired
Telegram chat also writes into; `sessionTarget: "current"`, as check-ins do), so it never
interrupts a running turn. OpenClaw commits the result into that conversation once no
turn runs there: the AgentPier chat shows it with a "Scheduled · <routine>" badge, a
later turn can refer to it, and an `agent-routine` push notice opens the chat. With
**Also send to Telegram** on, the result also goes to the paired Telegram chat, split
into several messages when it is long. OpenClaw's completion
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
(`NativeRoutines.reconcile`), including jobs that ran isolated because their agent
had no conversation then; reminders keep their tool-less isolated jobs. A routine
whose agent has no main chat yet opens one when it is created. Unpairing Telegram
never pauses or retires a routine.

A completion event triggers the saved prompt; it does not automatically insert
repository content or the coding result. Include only context appropriate for
that routine in the saved prompt.

OpenClaw owns schedules, execution and native run history. AgentPier stores the
delivery binding (main chat and optional Telegram chat) and event receipts, and uses
its existing Telegram outbox for the Telegram extra. Event routines are disabled native jobs triggered explicitly with
`cron.run`; enabling an event binding never enables a periodic native schedule.
Repeated event IDs do not rerun a job. An uncertain event acknowledgement is not
automatically replayed. Manual event delivery accepts a stable caller event ID.

Pausing/removing or disabling reminders prevents new bound delivery. Re-enabling
the capability does not silently resume paused routines. Native history and
Telegram acknowledgement are separate: a successful model run does not guarantee
Telegram delivery, while the chat record and push notice follow the accepted
completion. The model connection and host must be available.

A lead may also set routines up on its own permanent members
(`agentpier_team_member_routine`, `lead-routines.js`): each is the member's own
routine binding with `createdBy: "lead"`, run with the member's capabilities and its
lead's standing shares, and its result reaches the lead as an attributed
`member-result` report besides the member's chat. Such a run writes only when the
owner marked it **May write** or the lead's team usage is **Autonomous**; the lead's
tool cannot set either. The routine ends when the lead or member is archived or the
member leaves the lead (see the [Gateway guide](assistant-gateway.md#lead-routines-on-permanent-members-2026-10-19-agentpier-175)).

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
