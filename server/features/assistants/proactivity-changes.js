import { isDeepStrictEqual } from "node:util";
import { heartbeatSettings } from "./heartbeat-schedule.js";

/**
 * The proactive opt-ins a saved patch changes, as audit details: the changed names
 * and their new on/off flags, never a schedule or time zone. Null without a change.
 */
export function proactivityChange(current, patch) {
  const fields = [];
  const details = {};
  if (patch.heartbeat) {
    const before = heartbeatSettings(current);
    const after = heartbeatSettings(patch);
    if (
      before.enabled !== after.enabled ||
      (after.enabled && !isDeepStrictEqual(before, after))
    ) {
      fields.push("heartbeat");
      details.heartbeat = after.enabled;
    }
  }
  const recall = patch.capabilities?.recall;
  if (typeof recall === "boolean" && recall !== (current.capabilities?.recall === true)) {
    fields.push("recall");
    details.recall = recall;
  }
  return fields.length ? { kind: "proactivity", fields, ...details } : null;
}

/** Enabling check-ins (or moving them) needs a chat they can be delivered to. */
export function needsChannel(current, patch) {
  return (
    !!patch.heartbeat?.enabled && !isDeepStrictEqual(patch.heartbeat, current.heartbeat)
  );
}

/** One audit record per proactivity change; never fails the committed change. */
export function auditProactivity(audit, id, change) {
  if (!change) return;
  try {
    audit?.append({
      action: "assistant.updated",
      resourceType: "assistant",
      resourceId: id,
      source: "user",
      outcome: "success",
      details: change,
    });
  } catch (error) {
    console.error("Assistant proactivity audit failed:", error?.message);
  }
}
