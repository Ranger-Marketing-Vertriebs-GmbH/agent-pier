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
 * subagents) and the rest of Hermes's own toolsets stay on. `browser` only with the
 * Chromium AgentPier runs for the agent (`browser`, ADR 0006 decision 4), `image_gen`
 * only with images through AgentPier's runtime proxy (`images`, images.js). Not yet
 * mapped and therefore off: `cronjob` (the agent's own Hermes jobs, which bypass the
 * routines AgentPier sets up on the same scheduler) and `computer_use` (desktop
 * control AgentPier has no setting for).
 */
export function disabledToolsets(agent, level, { browser = false, images = false } = {}) {
  const shell = level !== "off";
  const { web } = agent;
  const off = [
    ...(browser ? [] : ["browser"]),
    "computer_use",
    "cronjob",
    ...(shell ? [] : ["terminal", "code_execution"]),
    // OpenClaw grants file tools with memory or the shell (native-capabilities.js);
    // Hermes reads a PDF's text with read_file (tools/file_tools.py), so reading PDFs
    // needs them too.
    ...(shell || agent.memory || web.readPdfs ? [] : ["file"]),
    ...(agent.memory ? [] : ["memory"]),
    ...(web.webSearch || web.webFetch ? [] : ["web"]),
    ...(web.documents ? [] : ["vision"]),
    // Hermes's image_generate on the owner's ChatGPT login AgentPier holds; never on
    // a FAL or Nous key, which AgentPier does not hold (tools/image_generation_tool.py).
    ...(images ? [] : ["image_gen"]),
  ];
  return [...new Set(off)].sort();
}
