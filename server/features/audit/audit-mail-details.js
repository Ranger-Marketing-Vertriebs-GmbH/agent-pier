// Email audit details (mail-account-store.js, mail/agent-mail-grants.js,
// mail/agent-mail-changes.js): the kind, the
// names of changed account fields, stable result codes and the account ids of grant
// changes. Never an address, host, username, subject, body, rule or password.
const kinds = ["account", "message"];
const accountFields = new Set([
  "name",
  "address",
  "displayName",
  "preset",
  "imap",
  "smtp",
  "allowPlaintext",
  "saveSent",
  "password",
]);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const isId = (value) => typeof value === "string" && idPattern.test(value);
const grantReasons = ["owner", "account-removed"];
// Whether a send went out; `unknown` when AgentPier cannot tell (an outcome of
// "failure" alone would read as not sent).
const deliveries = ["sent", "failed", "unknown"];
const resultCode = (value) =>
  typeof value === "string" && (value === "ok" || /^MAIL_[A-Z_]{2,40}$/.test(value));

export function mailAuditDetails(details, event, auditId) {
  if (kinds.includes(details.kind)) event.details.kind = details.kind;
  if (details.kind === "account" && Array.isArray(details.fields))
    event.details.fields = details.fields
      .filter((field) => accountFields.has(field))
      .slice(0, accountFields.size);
  for (const key of ["imap", "smtp"])
    if (resultCode(details[key])) event.details[key] = details[key];
  if (details.kind === "mail-grants") grantDetails(details, event);
  if (details.kind === "message") messageDetails(details, event, auditId);
}

// An agent's change to mail (Trash moves) or send: the agent, how many messages, and
// for a send what authorized it, how many recipients it had, whether it went out and
// a failure's code.
function messageDetails(details, event, auditId) {
  if (details.assistantId !== undefined)
    event.details.assistantId = auditId(details.assistantId);
  if (Number.isSafeInteger(details.count) && details.count >= 0 && details.count <= 1000)
    event.details.count = details.count;
  if (["rule", "approval"].includes(details.authorizedBy))
    event.details.authorizedBy = details.authorizedBy;
  if (
    Number.isSafeInteger(details.recipients) &&
    details.recipients >= 0 &&
    details.recipients <= 50
  )
    event.details.recipients = details.recipients;
  if (deliveries.includes(details.delivery)) event.details.delivery = details.delivery;
  if (resultCode(details.code) && details.code !== "ok")
    event.details.code = details.code;
}

// An agent's grant change: account ids, how many recipient rules it holds and why.
function grantDetails(details, event) {
  for (const key of ["added", "removed", "changed"])
    if (Array.isArray(details[key]) && details[key].length <= 20)
      event.details[key] = details[key].filter(isId);
  if (
    Number.isSafeInteger(details.ruleCount) &&
    details.ruleCount >= 0 &&
    details.ruleCount <= 1000
  )
    event.details.ruleCount = details.ruleCount;
  if (grantReasons.includes(details.reason)) event.details.reason = details.reason;
}
