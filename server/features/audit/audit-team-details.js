// Team audit details that say how an agent was allowed to act: a lead's routines on
// its members (lead-routines.js), native writes of a lead's follow-up on a member's
// result (member-result-writes.js) or of a command's completion run
// (exec-continuation.js) and the way a project file change was authorized.
// Ids, enums and paths only; never a routine's text or file content.
const changes = ["create", "update", "remove"];
const reasons = [
  "lead-gone",
  "lead-archived",
  "member-gone",
  "member-archived",
  "member-left",
];
const edited = ["name", "prompt", "trigger", "enabled"];
const safePath = (value) =>
  typeof value === "string" &&
  value.length <= 1024 &&
  !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);

export function teamAuditDetails(details, event, auditId) {
  if (["lead-share", "member-result", "exec-completion"].includes(details.via))
    event.details.via = details.via;
  for (const key of ["leadRequestId", "routineId", "sourceAttemptId"])
    if (details[key] !== undefined) event.details[key] = auditId(details[key]);
  if (details.kind === "lead-routine") {
    if (changes.includes(details.change)) event.details.change = details.change;
    if (["lead", "system"].includes(details.by)) event.details.by = details.by;
    if (reasons.includes(details.reason)) event.details.reason = details.reason;
    if (Array.isArray(details.edited))
      event.details.edited = details.edited.filter((key) => edited.includes(key));
  }
  if (details.kind === "native-write") {
    if (["write", "edit", "apply_patch"].includes(details.tool))
      event.details.tool = details.tool;
    if (safePath(details.filePath)) event.details.filePath = details.filePath;
  }
}
