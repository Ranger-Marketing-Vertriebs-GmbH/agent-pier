import { connectionMissing } from "./connection-state.js";
// Pure presentation of agent state. `copy` is passed in so callers use the reactive
// catalog and tests the plain one.
export const IDLE_ACTIVITY = Object.freeze({
  state: "idle",
  reason: null,
  label: null,
  pendingApprovals: 0,
  team: null,
});
const attentionAttempts = new Set(["uncertain", "interrupted"]);
const attentionRuntime = new Set(["failed", "stale"]);
const dots = { working: "working", waiting: "waiting", attention: "unknown" };

export function activityFor(activity, assistantId) {
  return activity?.[assistantId] ?? IDLE_ACTIVITY;
}

export function activityDot(entry) {
  return dots[entry?.state] ?? null;
}

export function copyAt(copy, path) {
  if (!path) return undefined;
  const value = path.split(".").reduce((node, key) => node?.[key], copy);
  return typeof value === "string" ? value : undefined;
}

// The header dot of a headerStatus tone: a failed runtime is an error, a stale runtime or
// an uncertain or interrupted turn a warning; "missing" shows no dot.
const headerDots = { ready: "ok", working: "working", waiting: "waiting" };
export function headerDotTone(tone, availability) {
  if (tone === "attention") return availability === "failed" ? "error" : "warning";
  return headerDots[tone] ?? "idle";
}

export function headerStatus({
  assistant,
  models,
  runtime,
  attempt,
  entry,
  member,
  copy,
  compacting = false,
}) {
  if (connectionMissing(assistant, models))
    return { tone: "missing", label: copy.status.connectionMissing };
  const availability = runtime?.availability;
  if (availability !== "ready")
    return {
      tone: attentionRuntime.has(availability) ? "attention" : "muted",
      label: copy.status[availability] ?? availability ?? "",
    };
  const current = entry ?? IDLE_ACTIVITY;
  // A turn waiting for the owner's approval stays accepted or running; the header
  // says what it waits for, as the sidebar does. An unclear outcome comes first.
  if (
    attempt &&
    !attentionAttempts.has(attempt.state) &&
    current.reason === "approval" &&
    current.pendingApprovals > 0
  )
    return {
      tone: "waiting",
      label: copyAt(copy, current.label) ?? copy.team.states.awaiting_approval,
    };
  // While the run summarises its long history first (compactions.js).
  // A summary the person asked for runs without a turn (long-chats.js).
  if (compacting && !attentionAttempts.has(attempt?.state))
    return { tone: "working", label: copy.status.compacting };
  if (attempt)
    return {
      tone: attentionAttempts.has(attempt.state) ? "attention" : "working",
      label: copy.status[attempt.state] ?? attempt.state,
    };
  if (current.state !== "idle")
    return {
      tone: current.state,
      label: copyAt(copy, current.label) ?? copy.status.ready,
    };
  if (member?.phase)
    return { tone: "ready", label: copy.team.states[member.phase] ?? copy.status.ready };
  return { tone: "ready", label: copy.status.ready };
}

export function sidebarSubline({ assistant, entry, member, model, copy }) {
  const current = entry ?? IDLE_ACTIVITY;
  if (current.team)
    return {
      text: copy.teamActive[current.team === "awaiting" ? "awaiting" : "working"],
      tone: "accent",
    };
  const label = current.state !== "idle" ? copyAt(copy, current.label) : undefined;
  const modelId = model?.modelId ?? assistant?.model?.modelId ?? "";
  // Members run on their own model, so it follows the status; the role (root rows) or
  // the assignment (team block) are added by the row itself.
  const withModel = (text) => (member && modelId ? `${text} · ${modelId}` : text);
  if (label) return { text: withModel(label), tone: "accent" };
  if (member)
    return {
      text: withModel(copy.team.states[member.phase] ?? member.phase),
      tone: "meta",
    };
  return { text: modelId, tone: "meta" };
}
