// An agent's coding sessions (assistants/coding-sessions/): which agent did what to
// a session it started. Ids, enums and flags only; never a prompt, a reply, an
// answer, a note or a launch option's text.
const ops = ["start", "send", "answer", "escalate", "stop", "worktree-remove"];
// A send: its delivery and what ChatDelivery answered.
const deliveryStatuses = ["pending", "handed-off", "rejected", "uncertain"];
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value);

export function agentSessionAuditDetails(details, event) {
  const s = details.agentSession;
  if (!s || typeof s !== "object" || !id(s.assistantId) || !ops.includes(s.op)) return;
  const kept = { assistantId: s.assistantId, op: s.op };
  for (const key of ["requestId", "actionId", "promptId"])
    if (id(s[key])) kept[key] = s[key];
  if (typeof s.worktree === "boolean") kept.worktree = s.worktree;
  if (id(s.deliveryId)) kept.deliveryId = s.deliveryId;
  if (deliveryStatuses.includes(s.status)) kept.status = s.status;
  event.details.agentSession = kept;
}

// A session prompt's answer names who answered (request-broker.js): the owner, an
// agent (with its id) or the owner through Telegram.
export function requestActorDetails(details, event) {
  if (!["owner", "agent", "telegram"].includes(details.actor)) return;
  event.details.actor = details.actor;
  if (details.actor === "agent" && id(details.assistantId))
    event.details.assistantId = details.assistantId;
}
