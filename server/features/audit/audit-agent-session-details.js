// An agent's coding sessions (assistants/coding-sessions/): which agent did what to
// a session it started. Ids, enums and flags only; never a prompt, a reply, an
// answer, a note or a launch option's text.
const ops = ["start", "send", "answer", "escalate", "stop", "worktree-remove"];
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value);

export function agentSessionAuditDetails(details, event) {
  const s = details.agentSession;
  if (!s || typeof s !== "object" || !id(s.assistantId) || !ops.includes(s.op)) return;
  const kept = { assistantId: s.assistantId, op: s.op };
  for (const key of ["requestId", "actionId", "promptId"])
    if (id(s[key])) kept[key] = s[key];
  if (typeof s.worktree === "boolean") kept.worktree = s.worktree;
  event.details.agentSession = kept;
}
