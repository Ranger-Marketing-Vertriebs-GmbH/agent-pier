// Email audit details (mail-account-store.js, mail/agent-mail-grants.js): the kind, the
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
const resultCode = (value) =>
  typeof value === "string" && (value === "ok" || /^MAIL_[A-Z_]{2,40}$/.test(value));

export function mailAuditDetails(details, event) {
  if (kinds.includes(details.kind)) event.details.kind = details.kind;
  if (details.kind === "account" && Array.isArray(details.fields))
    event.details.fields = details.fields
      .filter((field) => accountFields.has(field))
      .slice(0, accountFields.size);
  for (const key of ["imap", "smtp"])
    if (resultCode(details[key])) event.details[key] = details[key];
  if (details.kind === "mail-grants") grantDetails(details, event);
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
