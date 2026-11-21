import { auditActionCopy as copy } from "../../lib/i18n/messages/audit-actions.js";
import { operationsCopy } from "../../lib/i18n/messages/operations.js";

/**
 * An audit action (`<resource>.<verb>`) in words, such as "Backup created"; an action
 * outside the vocabulary stays as it is.
 */
export function auditActionLabel(action) {
  if (action === "ssh.key.exported") return copy.keyExported;
  const [resource, verb, ...rest] = String(action ?? "").split(".");
  const noun = copy.resources[resource];
  const done = copy.verbs[verb];
  return noun && done && !rest.length ? copy.label(noun, done) : String(action ?? "");
}

/** The action filter's choices: "All", then every action in the log in words. */
export function actionOptions(actions = [], current = "") {
  const known = current && !actions.includes(current) ? [current, ...actions] : actions;
  return [
    { value: "", label: operationsCopy.all },
    ...known.map((value) => ({ value, label: `${auditActionLabel(value)} (${value})` })),
  ];
}
