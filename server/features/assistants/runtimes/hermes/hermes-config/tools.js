// What an agent's desired state allows, as Hermes toolsets to switch off
// (`agent.disabled_toolsets`, website/docs/user-guide/configuration.md "Global
// Toolset Disable": applied after every platform's tool list, per tool) and Hermes's
// approval mode. Toolset names: toolsets.py at Hermes v0.22.5.

// Shell levels: AgentPier's (native-capabilities.js shellLevels) and the stricter
// Hermes-only one, every command asks (ADR 0006 decision 5).
export const everyCommand = "every-command";

/**
 * The agent's effective shell level: its desired level, raised from "approval" to
 * every-command when the start names it in `strict` (the runtime agent ids whose
 * owner chose that option; the desired state has no such level yet).
 */
export function shellLevel(agent, strict = []) {
  const { level } = agent.shell;
  if (level === "approval" && strict.includes(agent.runtimeAgentId)) return everyCommand;
  return [everyCommand, "approval", "full"].includes(level) ? level : "off";
}

/**
 * Hermes's `approvals.mode` for a shell level: `manual` asks the owner for the
 * commands Hermes flags as dangerous (its default `smart` lets an auxiliary model
 * approve them instead); `off` runs everything, as AgentPier's full access does.
 * Under `off` Hermes skips plugin approvals too (tools/approval.py
 * `_run_approval_gate`), so every-command needs `manual`.
 */
export const approvalMode = (level) => (level === "full" ? "off" : "manual");

/** Whether the AgentPier guard plugin asks before every command (guard-plugin.js). */
export const guardsEveryCommand = (level) => level === everyCommand;

/**
 * The Hermes toolsets the agent may not use, sorted. `delegation` (invisible
 * subagents) and the rest of Hermes's own toolsets stay on. Not yet mapped and
 * therefore off: `browser` (AgentPier will run each agent's Chromium, ADR 0006
 * decision 4), `cronjob` (routines need the messaging gateway, step 5) and
 * `computer_use` (desktop control AgentPier has no setting for).
 */
export function disabledToolsets(agent, level) {
  const shell = level !== "off";
  const { web } = agent;
  const off = [
    "browser",
    "computer_use",
    "cronjob",
    ...(shell ? [] : ["terminal", "code_execution"]),
    // OpenClaw grants file tools with memory or the shell (native-capabilities.js).
    ...(shell || agent.memory ? [] : ["file"]),
    ...(agent.memory ? [] : ["memory"]),
    ...(web.webSearch || web.webFetch ? [] : ["web"]),
    ...(web.documents ? [] : ["vision"]),
    ...(web.createImages ? [] : ["image_gen"]),
  ];
  return [...new Set(off)].sort();
}
