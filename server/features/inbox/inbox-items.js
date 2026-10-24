// What waits for the owner, as uniform inbox items. Each item names where it comes
// from and links back there; answering always goes through that source's own
// endpoint, so an item carries no more than the source's own card shows.
export const inboxTypes = ["question", "approval", "gate", "action", "team"];
export const inboxTabs = ["questions", "approvals", "gates", "agents"];
const tabOf = {
  question: "questions",
  approval: "approvals",
  gate: "gates",
  action: "agents",
  team: "agents",
};
// An item expiring within this window counts as "about to expire" and comes first.
export const expiringSoonMs = 15 * 60000;
const titleLimit = 200;

const text = (value) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, titleLimit) : "";
const iso = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const folder = (cwd) =>
  typeof cwd === "string" ? cwd.split("/").filter(Boolean).at(-1) || "" : "";
const segment = (value) => encodeURIComponent(String(value));

function item(type, values) {
  return {
    type,
    tab: tabOf[type],
    ...values,
    title: text(values.title),
    createdAt: iso(values.createdAt) || new Date(0).toISOString(),
    expiresAt: iso(values.expiresAt),
  };
}

/** A native CLI question or approval (request-broker.js listAll). */
export function requestItem(entry, session) {
  const question = entry.kind === "question";
  const first = entry.questions?.[0];
  const subject = entry.subject || {};
  return item(question ? "question" : "approval", {
    id: entry.id,
    kind: entry.presentation || entry.kind,
    status: entry.status,
    revision: entry.revision,
    source: {
      kind: "session",
      id: entry.sessionId,
      name: session?.name || entry.sessionId,
      tool: entry.source,
    },
    // The question itself, or what the CLI wants to do; never a command line.
    title: question
      ? first?.header || first?.prompt
      : entry.presentation
        ? ""
        : subject.description || subject.tool || subject.name,
    createdAt: entry.createdAt,
    expiresAt: null,
    link: `/sessions/${segment(entry.sessionId)}/chat`,
  });
}

/** A pipeline run waiting at a gate or for a decision on a stage. */
export function gateItem(run) {
  const node = run.nodes?.find((n) => n.id === run.currentNodeId);
  const attempt = run.executionLog?.find((a) => a.id === run.currentAttemptId);
  return item("gate", {
    id: run.id,
    kind: node && !node.failReason ? "gate" : "decision",
    status: run.status,
    revision: run.revision,
    source: {
      kind: "pipeline",
      id: run.id,
      name: run.pipelineName || run.pipelineId || "",
      project: folder(run.workingDir || run.cwd),
    },
    title: node ? node.profileSnapshot?.name || node.label || node.kind || node.id : "",
    stage: node?.id || null,
    // A stage held at the token budget may not have started yet.
    createdAt:
      node?.budgetHold?.at || attempt?.finishedAt || node?.startedAt || run.createdAt,
    expiresAt: null,
    link: `/pipelines/runs/${segment(run.id)}`,
  });
}

/** The chat an agent action is decided in: its own, or the agent's open one. */
function chatLink(assistantId, conversationId, conversations) {
  const own =
    conversations.find(
      (c) => c.id === conversationId && c.assistantId === assistantId && !c.archivedAt,
    ) || conversations.find((c) => c.assistantId === assistantId && !c.archivedAt);
  return own
    ? `/agents/${segment(assistantId)}/chats/${segment(own.id)}`
    : `/agents/${segment(assistantId)}/settings`;
}

const actionTitle = (a) => {
  const p = a.payload || {};
  if (p.action === "coding_start") return p.task;
  if (p.action === "memory_write") return p.title || p.content;
  if (p.action === "ssh" || p.action === "sftp") return p.hostName;
  if (p.action === "member_grant") return p.memberName;
  return "";
};

/** An agent action awaiting approval: shell and SSH commands, coding, memory, grants. */
export function actionItem(action, agents, conversations) {
  const agent = agents.get(action.assistantId);
  return item("action", {
    id: action.id,
    kind: action.payload?.action || "action",
    status: action.state,
    revision: action.revision,
    source: { kind: "agent", id: action.assistantId, name: agent?.name || "" },
    ...(action.teamId ? { teamId: action.teamId } : {}),
    ...(action.memberName ? { memberName: text(action.memberName) } : {}),
    title: actionTitle(action),
    createdAt: action.createdAt,
    expiresAt: action.expiresAt,
    link: chatLink(action.assistantId, action.conversationId, conversations),
  });
}

/** A lead agent's team proposal waiting for the owner. */
export function teamItem(team, agents, conversations) {
  const lead = agents.get(team.parentAssistantId);
  return item("team", {
    id: team.id,
    kind: "proposal",
    status: team.phase,
    revision: team.revision,
    source: { kind: "agent", id: team.parentAssistantId, name: lead?.name || "" },
    title: team.objective,
    members: Array.isArray(team.members) ? team.members.length : 0,
    createdAt: team.createdAt,
    expiresAt: null,
    link: chatLink(team.parentAssistantId, team.parentConversationId, conversations),
  });
}

/** About to expire first (soonest first), then the longest waiting. */
export function sortItems(items, now = Date.now()) {
  const soon = (i) =>
    i.expiresAt !== null && Date.parse(i.expiresAt) - now <= expiringSoonMs;
  return [...items].sort((a, b) => {
    const sa = soon(a),
      sb = soon(b);
    if (sa !== sb) return sa ? -1 : 1;
    const order = sa
      ? Date.parse(a.expiresAt) - Date.parse(b.expiresAt)
      : Date.parse(a.createdAt) - Date.parse(b.createdAt);
    return order || `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`);
  });
}

export function countItems(items) {
  const counts = { all: items.length };
  for (const tab of inboxTabs) counts[tab] = 0;
  for (const i of items) counts[i.tab]++;
  return counts;
}

/** Changes whenever an item comes, goes or changes its state. */
export function itemsSignature(items) {
  return items
    .map((i) => `${i.type}:${i.id}:${i.status ?? ""}:${i.revision ?? ""}`)
    .sort()
    .join("|");
}
