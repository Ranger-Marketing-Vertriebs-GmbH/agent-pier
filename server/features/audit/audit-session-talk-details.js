// A session asking an agent or telling it something (session.asked, session.told):
// ids and enums only; never the text of the message or the answer.
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value);

export function sessionTalkAuditDetails(details, event) {
  const t = details.sessionTalk;
  if (
    !t ||
    typeof t !== "object" ||
    !id(t.assistantId) ||
    !["ask", "tell"].includes(t.op)
  )
    return;
  const kept = { assistantId: t.assistantId, op: t.op };
  if (id(t.requestId)) kept.requestId = t.requestId;
  if (["project", "session"].includes(t.via)) kept.via = t.via;
  if (["queued", "limited", "refused"].includes(t.status)) kept.status = t.status;
  event.details.sessionTalk = kept;
}
