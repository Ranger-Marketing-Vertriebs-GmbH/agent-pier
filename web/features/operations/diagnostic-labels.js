import { diagnosticCopy as copy } from "../../lib/i18n/messages/operations.js";
export function checkLabel(id) {
  if (copy.checks[id]) return copy.checks[id];
  if (id.startsWith("account.")) return `${copy.account}: ${id.slice(8)}`;
  if (id.startsWith("project.")) return `${copy.project}: ${id.slice(8)}`;
  return id;
}
