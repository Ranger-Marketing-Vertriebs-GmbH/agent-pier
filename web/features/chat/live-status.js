import { chatObservabilityCopy as copy } from "../../lib/i18n/messages/chat-observability.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";

// What a CLI reports doing right now, from the chat stream's `live-status` frames
// (server/features/claude-mod/claude-mod-bridge.js): Working or Ready the moment a
// turn starts or ends, and what the turn is busy with. Only the Claude Code bridge
// mod sends it; other sessions keep the polled activity alone.

/** The frame's status in a known shape, or null. */
export function liveValue(frame) {
  const status = frame?.status;
  if (!status || !["working", "idle"].includes(status.state)) return null;
  const count = (value) => (Number.isInteger(value) && value > 0 ? value : 0);
  return {
    state: status.state,
    phase: ["thinking", "compacting"].includes(status.phase) ? status.phase : null,
    tool: typeof status.tool === "string" ? status.tool.slice(0, 120) : "",
    agents: count(status.agents),
    at: Number.isFinite(status.at) ? status.at : 0,
  };
}

/**
 * The header's activity with the live status: a newer live report decides Working
 * or Ready (a dialog the polled activity shows keeps waiting), and `detail` says
 * what the turn does now.
 */
export function liveActivity(activity, live, running = true) {
  if (!live || !running || activity.state === "waiting")
    return { ...activity, detail: "" };
  const observed = Date.parse(activity.observedAt || "") || 0;
  const state = live.at >= observed ? live.state : activity.state;
  const labels = { working: commonCopy.working, idle: commonCopy.ready };
  const working = state === "working";
  const detail =
    working && live.phase === "compacting"
      ? copy.liveCompacting
      : working && live.tool
        ? copy.liveTool(live.tool.replace(/^mcp__/, ""))
        : working && live.phase === "thinking"
          ? copy.liveThinking
          : live.agents
            ? copy.liveAgents(live.agents)
            : "";
  return { state, label: labels[state] || activity.label, detail };
}
