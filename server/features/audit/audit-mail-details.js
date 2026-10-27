// Email audit details (mail-account-store.js): the kind, the names of changed account
// fields and stable result codes. Never an address, host, username, subject, body or
// password.
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
}
