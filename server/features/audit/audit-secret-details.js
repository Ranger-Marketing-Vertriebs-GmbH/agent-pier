// Agent secret audit details (secret-store.js): the name and which fields changed.
// Never a value or a description.
const names = /^[A-Z_][A-Z0-9_]{0,63}$/;
const fields = ["name", "description", "project", "value"];

export function secretAuditDetails(details, event) {
  if (typeof details.name === "string" && names.test(details.name))
    event.details.name = details.name;
  if (Array.isArray(details.changed))
    event.details.changed = fields.filter((field) => details.changed.includes(field));
}
