import { diagnosticCopy as copy } from "../../lib/i18n/messages/operations.js";
export function checkLabel(id) {
  if (copy.checks[id]) return copy.checks[id];
  if (id.startsWith("account.")) return `${copy.account}: ${id.slice(8)}`;
  if (id.startsWith("project.")) return `${copy.project}: ${id.slice(8)}`;
  if (id.startsWith("adapter-session.")) return `${copy.adapterSession}: ${id.slice(16)}`;
  return id;
}
// A remedy is shown only for checks that need action, translated by its stable id.
export function remedyText(check) {
  if (check.status !== "warn" && check.status !== "fail") return null;
  if (check.remedyId && copy.remedies[check.remedyId])
    return copy.remedies[check.remedyId];
  return typeof check.remedy === "string" && check.remedy ? check.remedy : null;
}
