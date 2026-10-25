import { assistantProblem } from "./assistant-validation.js";
import { fileActions } from "./agent-project-files.js";

// A hook run's agentpier_workspace calls (agent-hook-bridge.js passes `inv.hook`):
// the hook's rights capped by what the agent holds now, re-resolved through
// AgentHooks.runOrigin on every call, so a folder or a coding grant the agent lost
// mid-run is gone on the next call. Folders at min(hook, agent) level; with Coding,
// coding requests on the agent's own projects start without a card
// (workspace-calls.js). Project memory, the action list, cancelling a run and
// staging browser uploads are never part of a hook run.
const codingActions = new Set(["coding_start", "coding_status", "coding_artifacts"]);

/** The workspace context of a hook run; throws 403 once its event no longer runs. */
export function hookContext(w, inv) {
  const agent = w.access.eligible(inv.hook.conversation.assistantId);
  const run = w.a.routines?.hooks?.runOrigin(agent, inv.sessionKey);
  if (!run || run.event.id !== inv.hook.event.id) throw assistantProblem("invalid", 403);
  return {
    assistantId: agent.id,
    conversationId: run.conversation.id,
    attemptId: null,
    origin: { kind: "hook", hookId: run.hook.id, eventId: run.event.id },
    hook: {
      hookId: run.hook.id,
      eventId: run.event.id,
      name: run.hook.name,
      coding: run.effective.coding === true,
      folders: { ...run.effective.folders },
      key: `hook:${run.event.id}`,
    },
  };
}

/** Whether a hook run may call this workspace action at all. */
export function hookActionAllowed(ctx, action) {
  if (action === "catalog") return true;
  if (fileActions.has(action)) return Object.keys(ctx.hook.folders).length > 0;
  if (codingActions.has(action)) return ctx.hook.coding;
  return false;
}

/** Notes a coding request on its event (the event area links it); never throws. */
export function recordHookCoding(w, ctx, action) {
  try {
    const events = w.a.routines?.hooks?.events;
    // get and patch stay synchronous: no other write can slip in between.
    const event = events?.get(ctx.hook.eventId);
    if (!event) return;
    const coding = [...(event.coding || [])];
    if (!coding.includes(action.id)) coding.push(action.id);
    events.patch(event.id, { coding });
  } catch (error) {
    console.error("Hook coding record failed:", error?.message);
  }
}
