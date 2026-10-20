import { maxReplyText } from "../requests/native-push.js";

// The reports of the `agentpier-bridge` mod (bridge-mod.js), checked before anything
// reads them. A batch is all or nothing: one malformed event refuses the request.
export const claudeModProtocol = 1;
export const maxModEvents = 256;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const label = (value) => typeof value === "string" && LABEL.test(value);
const count = (value, limit) => Number.isInteger(value) && value >= 0 && value <= limit;
// Tool and agent type names as Claude Code reports them (`Bash`, `mcp__x__y`, `Explore`).
const name = (value) =>
  typeof value === "string" && /^[^\0-\x1f\x7f]{0,120}$/.test(value) ? value : null;

function event(value) {
  const invalid = () => {
    throw Error("Invalid Claude mod event");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const { type } = value;
  if (type === "hello")
    return {
      type,
      ...(typeof value.cli === "string" && /^[0-9A-Za-z.+-]{1,40}$/.test(value.cli)
        ? { cli: value.cli }
        : {}),
    };
  if (type === "turn.start") {
    if (!label(value.turn)) invalid();
    return { type, turn: value.turn };
  }
  if (type === "text") {
    if (
      !label(value.turn) ||
      !count(value.step, 10000) ||
      !count(value.block, 10000) ||
      !count(value.order, 10000) ||
      !count(value.from, maxReplyText) ||
      typeof value.text !== "string" ||
      value.text.includes("\0") ||
      value.from + value.text.length > maxReplyText
    )
      invalid();
    const { turn, step, block, order, from, text } = value;
    return { type, turn, step, block, order, from, text };
  }
  if (type === "phase") {
    if (!label(value.turn) || value.phase !== "thinking") invalid();
    return { type, turn: value.turn, phase: value.phase };
  }
  if (type === "tool.start" || type === "agent.start") {
    const kind = name(type === "tool.start" ? value.name : value.kind);
    if (!label(value.id) || kind === null) invalid();
    return type === "tool.start"
      ? { type, id: value.id, name: kind }
      : { type, id: value.id, kind };
  }
  if (type === "tool.end" || type === "agent.end") {
    if (!label(value.id)) invalid();
    return { type, id: value.id };
  }
  if (type === "turn.complete") {
    if (!label(value.turn) || typeof value.aborted !== "boolean") invalid();
    return {
      type,
      turn: value.turn,
      aborted: value.aborted,
      ...(count(value.durationMs, 7 * 24 * 3600 * 1000)
        ? { durationMs: value.durationMs }
        : {}),
      ...(count(value.usage?.input, 1e9) && count(value.usage?.output, 1e9)
        ? { usage: { input: value.usage.input, output: value.usage.output } }
        : {}),
    };
  }
  if (["compact.start", "compact.end", "session.end"].includes(type)) return { type };
  // A report this server does not know yet (a newer mod copy) is skipped.
  if (typeof type !== "string" || !/^[a-z][a-z.]{0,39}$/.test(type)) invalid();
  return null;
}

/** The validated events of one request body, or an error. */
export function claudeModEvents(body) {
  if (
    !body ||
    typeof body !== "object" ||
    body.protocol !== claudeModProtocol ||
    !Array.isArray(body.events) ||
    body.events.length > maxModEvents
  )
    throw Error("Invalid Claude mod report");
  return body.events.map(event).filter(Boolean);
}
