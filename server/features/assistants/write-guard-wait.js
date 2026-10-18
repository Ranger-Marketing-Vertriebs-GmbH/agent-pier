import { memoryEnabled, personalCapabilities } from "./native-capabilities.js";
import { textValue, validateSendInput } from "./assistant-validation.js";
// After a Gateway (re)start the agents run without write and edit until the team
// plugin reports its write guard (WRITE_GUARD_PENDING, team-bridge.js). An owner
// turn admitted in that window would silently lose what it was asked to remember,
// so it waits, outside the admission lock, until the guard is back, but only within
// a window after the Gateway became ready: one report interval
// (team-plugin/tool-guard.js guardReportMs) plus a margin. A guard that never
// reports does not hold turns any longer; they run read-only and say so.
export const writeGuardWindowMs = 20000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Agents whose tools wait for the guard: memory writes (memoryEnabled, members' own
 * memory included) and the browser.
 */
export const guardNeeded = (assistant) =>
  memoryEnabled(assistant) ||
  personalCapabilities(assistant).browser ||
  personalCapabilities(assistant).createImages;
const ownTurn = (context) =>
  ["owner", "telegram"].includes(context?.kind) && !context.forwarded;

/** AssistantConfig's view of the guard (assistant-graph.js wires it). */
export function writeGuardWiring({ bridge, nativeReady }) {
  return {
    // A memory or browser agent on a ready Gateway whose guard has not reported.
    writeGuardPending: (assistant) =>
      !!nativeReady() && guardNeeded(assistant) && bridge.guardPending(true),
    // The end of the current readiness's wait window (0: no ready Gateway yet).
    writeGuardDeadline: () =>
      bridge.readyAt == null ? 0 : bridge.readyAt + writeGuardWindowMs,
  };
}

const warned = new WeakMap();
/** Waits while the guard is pending and the window is open. */
export async function awaitWriteGuard(service, conversationId, input, context) {
  // An invalid request is refused before it could wait.
  validateSendInput(input);
  textValue(input.clientRequestId, 100);
  const pending = service.config.writeGuardPending;
  if (!ownTurn(context) || !pending) return;
  // A retry returns the accepted request and sends nothing.
  if (
    service.ledger
      .requests(conversationId)
      .some((r) => r.clientRequestId === input.clientRequestId)
  )
    return;
  const assistant = service.store.getAssistant(
    service.store.getConversation(conversationId).assistantId,
  );
  const deadline =
    service.config.writeGuardDeadline?.() ?? Date.now() + writeGuardWindowMs;
  while (pending(assistant) && Date.now() < deadline && !service.closed)
    await pause(service.writeGuardPollMs ?? 100);
  if (pending(assistant) && warned.get(service) !== deadline) {
    warned.set(service, deadline);
    (service.warn || console.warn)(
      "Write guard not reported within its window after the agent service became ready; owner turns run without memory writes until it reports.",
    );
  }
}

/**
 * Owner turns of one conversation reach admission in the order they were sent,
 * however long each waited; `start` runs once the earlier ones were admitted.
 */
export function orderedTurn(service, conversationId, wait, start) {
  const queues = (service.turnQueues ??= new Map());
  const admitted = (queues.get(conversationId) || Promise.resolve())
    .then(wait)
    .then(() => ({ result: start() }));
  const tail = admitted.then(
    () => {},
    () => {},
  );
  queues.set(conversationId, tail);
  tail.then(() => {
    if (queues.get(conversationId) === tail) queues.delete(conversationId);
  });
  return admitted.then(({ result }) => result);
}

/**
 * A turn applied without writes (sendTurn's `readOnly`) gets a chat note; its
 * AGENTS.md already tells the agent that memory is read-only
 * (assistant-bootstrap.js). Retries of an accepted request add nothing.
 */
export function noteReadOnlyTurn(service, conversationId, context, result) {
  if (!result?.readOnly || !ownTurn(context)) return;
  const added = service.memoryNotes.record({
    key: `guard-pending:${result.request.id}`,
    conversationId,
    reason: "guard-pending",
  });
  if (added) service.changed();
}
