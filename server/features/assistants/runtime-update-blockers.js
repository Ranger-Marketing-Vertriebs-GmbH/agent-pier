import { createHash } from "node:crypto";

// What blocks an agent runtime update, item by item (AssistantMaintenance.blockers).
// Each item names its blocker code (kept for compatibility), what it is (`kind`), the
// agent it belongs to, since when it waits, where the owner resolves it, what "Pause
// agents and update" would do with it (`resolution`) and a `revision` that changes
// whenever anything that decision depends on changes. Items carry ids, names and
// times only; never a message, a command or a routine's text.
export const blockerOrder = [
  "ASSISTANT_WORK",
  "TEAM_WORK",
  "CHANNEL_WORK",
  "ACCOUNT_LOGIN",
  "WORKFLOW_WORK",
  "SCHEDULED_WORK",
];
// What the forced update does with an item: stop a running turn, mark an unknown
// outcome reviewed, cancel a task or action, close a Telegram entry without sending
// it, wait for a run that cannot be stopped from AgentPier, or nothing (a sign-in
// in progress is never cancelled for an update).
export const resolutions = ["stop", "review", "cancel", "close", "wait", "none"];
const memberTerminal = new Set(["completed", "failed", "cancelled"]);
const teamBusy = new Set(["approved", "queued", "running", "stopping"]);
const workflowBusy = new Set(["approved", "executing", "unknown", "running"]);
const unknownOutcome = new Set(["uncertain", "interrupted"]);
const segment = (value) => encodeURIComponent(String(value));

const revisionOf = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
function iso(value) {
  if (value === null || value === undefined || value === "") return null;
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function lookup(read) {
  try {
    return read() ?? null;
  } catch {
    return null;
  }
}
function agentOf(s, assistantId) {
  if (typeof assistantId !== "string" || !assistantId) return null;
  const agent = lookup(() => s.assistants.store.getAssistant(assistantId));
  return { id: assistantId, name: typeof agent?.name === "string" ? agent.name : "" };
}
// The chat to open: the owner's own chat of the agent; a user's chat is theirs alone,
// so the owner gets the agent's settings instead.
function chatLink(s, assistantId, conversationId) {
  if (!assistantId) return "/agents";
  const chat = conversationId
    ? lookup(() => s.assistants.store.getConversation(conversationId))
    : null;
  return chat && typeof chat.userId !== "string" && !chat.archivedAt
    ? `/agents/${segment(assistantId)}/chats/${segment(chat.id)}`
    : `/agents/${segment(assistantId)}/settings`;
}
const channelLink = (assistantId) =>
  assistantId
    ? `/agents/${segment(assistantId)}/settings?tab=channels&page=telegram-activity`
    : "/agents";

function item(code, kind, rawId, values, state) {
  return {
    id: `${kind}:${rawId}`,
    code,
    kind,
    agent: values.agent ?? null,
    since: iso(values.since),
    link: values.link,
    resolution: values.resolution,
    revision: revisionOf([kind, rawId, state]),
    // Server side only: what the resolution acts on (publicItem leaves it out).
    ref: { id: rawId, ...values.ref },
  };
}
/** An item as the browser sees it. */
export const publicItem = ({ ref: _ref, ...visible }) => visible;
/** The blocker codes of `items`, once each, in their fixed order. */
export const blockerCodes = (items) =>
  blockerOrder.filter((code) => items.some((i) => i.code === code));

function chatTurns(s, items) {
  const a = s.assistants;
  for (const attempt of a.ledger.pending()) {
    const request = lookup(() => a.ledger.getRequest(attempt.requestId));
    const chat = request
      ? lookup(() => a.store.getConversation(request.conversationId))
      : null;
    items.push(
      item(
        "ASSISTANT_WORK",
        "chat_turn",
        attempt.id,
        {
          agent: agentOf(s, chat?.assistantId),
          since: attempt.createdAt,
          link: chatLink(s, chat?.assistantId, chat?.id),
          resolution: unknownOutcome.has(attempt.state) ? "review" : "stop",
        },
        [attempt.state, attempt.reviewedAt ?? null, attempt.runtimeRunId ?? null],
      ),
    );
  }
  // A history summarised on request runs in the Gateway too (long-chats.js).
  const long = a.longChats;
  if (!long?.runningFor?.()) return;
  const chats = long.running instanceof Map ? [...long.running.keys()] : ["running"];
  for (const id of chats) {
    const chat = lookup(() => a.store.getConversation(id));
    items.push(
      item(
        "ASSISTANT_WORK",
        "chat_summary",
        id,
        {
          agent: agentOf(s, chat?.assistantId),
          since: null,
          link: chatLink(s, chat?.assistantId, chat?.id),
          resolution: "wait",
        },
        ["running"],
      ),
    );
  }
}

function teams(s, items) {
  const store = s.assistantTeams?.store;
  if (!store) return;
  const members = store.members(),
    list = store.list();
  const open = new Set([
    ...list.filter((t) => teamBusy.has(t.phase)).map((t) => t.id),
    ...members.filter((m) => !memberTerminal.has(m.phase)).map((m) => m.teamId),
  ]);
  for (const id of open) {
    const team = list.find((t) => t.id === id);
    const own = members.filter((m) => m.teamId === id);
    items.push(
      item(
        "TEAM_WORK",
        "team_task",
        id,
        {
          agent: agentOf(s, team?.parentAssistantId),
          since: team?.createdAt,
          link: team?.parentAssistantId
            ? chatLink(s, team.parentAssistantId, team.parentConversationId)
            : "/agents?tab=teams",
          resolution: "cancel",
          ref: { members: own.map((m) => m.id) },
        },
        [
          team?.phase ?? null,
          team?.revision ?? null,
          own.map((m) => [m.id, m.phase, m.attemptId ?? null]),
        ],
      ),
    );
  }
}

function channels(s, items) {
  const c = s.assistantChannels;
  for (const channel of c.store.list()) {
    const agent = agentOf(s, channel.assistantId),
      link = channelLink(channel.assistantId);
    for (const entry of c.ledger.active(channel.id))
      items.push(
        item(
          "CHANNEL_WORK",
          "channel_input",
          entry.id,
          {
            agent,
            since: entry.createdAt,
            link,
            resolution: "close",
            ref: { channelId: channel.id },
          },
          [entry.state, entry.attemptId ?? null, entry.diagnostic ?? null],
        ),
      );
    for (const entry of c.outbox.pending(channel.id))
      items.push(
        item(
          "CHANNEL_WORK",
          "channel_notice",
          entry.id,
          {
            agent,
            since: entry.createdAt,
            link,
            resolution: "close",
            ref: { channelId: channel.id },
          },
          [entry.state, entry.diagnostic ?? null],
        ),
      );
  }
}

function login(s, items) {
  const attempt = s.assistantModelLogin?.attempt;
  if (!["starting", "awaiting_user"].includes(attempt?.status)) return;
  items.push(
    item(
      "ACCOUNT_LOGIN",
      "login",
      attempt.id,
      {
        agent: null,
        since: attempt.startedAt,
        link: "/connections?section=models&item=chatgpt",
        resolution: "none",
      },
      [attempt.status],
    ),
  );
}

// An approved action not yet started is cancelled, an agent's coding run through its
// pipeline's cancel; an unknown outcome is reviewed. A command, transfer or email that
// executes right now is waited for: AgentPier cannot take it back halfway.
function workflowResolution(action) {
  if (action.state === "approved") return "cancel";
  if (action.state === "unknown") return "review";
  if (
    action.state === "running" &&
    action.payload?.action === "coding_start" &&
    action.runId
  )
    return "cancel";
  return "wait";
}
function workflows(s, items) {
  for (const action of s.assistants.workflows?.store.list() || []) {
    if (!workflowBusy.has(action.state)) continue;
    items.push(
      item(
        "WORKFLOW_WORK",
        "workflow",
        action.id,
        {
          agent: agentOf(s, action.assistantId),
          since: action.updatedAt ?? action.createdAt,
          link: chatLink(s, action.assistantId, action.conversationId),
          resolution: workflowResolution(action),
        },
        [action.state, action.revision ?? null],
      ),
    );
  }
}

async function routines(s, items) {
  const reminders = s.assistantReminders;
  if (!s.assistantRuntime.client?.ready || !reminders) return;
  // Reminders and routines, but also check-ins, a lead's routines and jobs an agent
  // created itself (native-reminders.js runningJobs).
  const jobs = reminders.runningJobs
    ? await reminders.runningJobs()
    : (await reminders.hasRunning?.())
      ? [{ id: "running" }]
      : [];
  const agents = lookup(() => s.assistants.store.listAssistants()) || [];
  for (const job of jobs) {
    const assistantId = agents.find((a) => a.runtimeAgentId === job.agentId)?.id;
    items.push(
      item(
        "SCHEDULED_WORK",
        "routine_run",
        job.id,
        {
          agent: agentOf(s, assistantId),
          since: job.state?.runningAtMs,
          link: assistantId
            ? `/agents/${segment(assistantId)}/settings?tab=automation`
            : "/agents",
          resolution: "wait",
        },
        [job.state?.runningAtMs ?? null],
      ),
    );
  }
}

/**
 * Every item that blocks an update now, read without changing anything. Throws as
 * the Gateway's cron list does, like the codes did before.
 */
export async function blockerItems(s) {
  const items = [];
  chatTurns(s, items);
  teams(s, items);
  channels(s, items);
  login(s, items);
  workflows(s, items);
  await routines(s, items);
  return items;
}
