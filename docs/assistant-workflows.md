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

Ask the agent to inspect project knowledge or propose a concrete coding task.
The workspace tool first discovers the granted project/pipeline IDs. Approval
shows the project, pipeline, exact task and optional base branch, or the exact
memory change. Owner decisions are available in the agent's settings (**Work → Actions and coding
tasks**) and in its chat; Telegram-origin
proposals also have approval buttons bound to the original channel/chat/user.
Approvals expire after 24 hours. The model cannot grant itself access or accept
human review gates inside pipelines. Forwarded Telegram messages are quoted data
and cannot invoke workspace, reminder or routine tools as owner instructions.

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
