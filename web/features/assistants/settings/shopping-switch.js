// Why an agent cannot get the built-in Shopping skill, as the server decides it
// (server/features/assistants/built-in-skills.js shoppingBlocker and shoppingOn),
// read from the Capabilities draft so a browser or memory switch shows at once.

const temporary = (assistant) =>
  !!assistant?.teamMemberId && assistant.lifetime !== "permanent";

/**
 * `archived`, `userAgent`, the missing `browser` or `memory`, `lead` (a task member
 * whose lead has shopping off), or null. `values` is the tab's draft.
 */
export function shoppingBlocker(assistant, values = {}) {
  if (!assistant || assistant.archivedAt) return "archived";
  if (assistant.userAccess) return "userAgent";
  if (temporary(assistant)) {
    // A task member: its lead's browser grant, its own memory, its lead's switch.
    if (assistant.inherited?.capabilities?.browser !== true) return "browser";
    return assistant.inherited.shopping === false ? "lead" : null;
  }
  // A permanent member also holds what its lead shares with it.
  const shared = assistant.leadCapabilities || {};
  if (values.browser !== true && shared.browser !== true) return "browser";
  if (values.memory !== true && shared.memory !== true) return "memory";
  return null;
}
