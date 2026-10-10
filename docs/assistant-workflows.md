# Agent workflows

AgentPier reuses existing project memory and coding pipelines. OpenClaw remains
responsible for personal memory, scheduled execution and routine history. This
slice adds explicit project access, action approvals and links between those
existing systems. Gmail, Microsoft 365, Google Calendar, Apple integrations and
sandbox decisions remain deferred.

## Project access and actions

In **Agents > agent > Settings > Projects and coding tasks**, select registered
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
memory change. Owner decisions are available in Agent Settings; Telegram-origin
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
in the team card of the parent's chat and, when a Telegram chat is bound (the
chat that started the team, otherwise the parent's paired chat), as a Telegram
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

A reminder repeats prescribed text. A routine asks the configured model to answer
its saved prompt each time. Scheduled routine turns have no tools and cannot
start coding jobs, write project knowledge or take external service actions.
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
