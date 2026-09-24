import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { isVerifying } from "./VerificationStatus.jsx";

// CLI product names are not translated.
const cliNames = { codex: "Codex", claude: "Claude Code", opencode: "OpenCode" };
export const cliName = (tool) => cliNames[tool] || tool || "";

export const stageName = (node) => node.profileSnapshot?.name || node.kind || node.id;

// Status colour class shared by the rail number, the detail dot and chips.
export function stageTone(run, node) {
  if (isVerifying(run, node)) return "running";
  return (
    {
      pending: "pending",
      running: "running",
      "awaiting-gate": "waiting",
      passed: "ok",
      failed: "error",
    }[node.status] || "neutral"
  );
}

export function stageStatus(run, node) {
  const status = isVerifying(run, node)
    ? copy.verificationRunning
    : copy.nodeStatuses[node.status] || node.status;
  return node.loop
    ? `${status} · ${node.loop.iteration} / ${node.loop.maxIterations}`
    : status;
}

// A live run opens on its current stage. A finished run opens on the stage that ran
// last, so branches that were never taken (and stay pending) are skipped. Without either,
// the first stage that has not passed is shown, else the last.
export function defaultStageId(run) {
  const nodes = run.nodes || [];
  const known = (id) => nodes.some((node) => node.id === id);
  const terminal = ["completed", "failed", "cancelled"].includes(run.status);
  if (!terminal && known(run.currentNodeId)) return run.currentNodeId;
  if (terminal) {
    const executed = (run.executionLog || []).findLast((entry) => known(entry.nodeId));
    if (executed) return executed.nodeId;
    const passed = nodes.findLast((node) => node.status === "passed");
    if (passed) return passed.id;
  }
  return (nodes.find((node) => node.status !== "passed") || nodes.at(-1))?.id || "";
}

// Flags come from the compiled run graph: side effects ride on a stage's forward edges
// and a fail edge with a loop budget points back to an earlier stage. Shapes the graph
// cannot express simply yield no flag.
export function stageFlags(run, node) {
  const edges = Array.isArray(run.edges) ? run.edges : [];
  const forward = edges.filter(
    (edge) => edge.from === node.id && edge.condition !== "fail",
  );
  const effect = (key) =>
    node[key] === true || forward.some((edge) => edge.effects?.[key] === true);
  const flags = [
    effect("humanGate") && { key: "gate", label: copy.stageFlags.gate },
    effect("verify") && { key: "verify", label: copy.stageFlags.verify },
    effect("createPr") && { key: "pr", label: copy.stageFlags.pr },
  ];
  const loop = edges.find(
    (edge) =>
      edge.from === node.id &&
      edge.condition === "fail" &&
      edge.maxIterations !== undefined,
  );
  const target = loop ? (run.nodes || []).findIndex((item) => item.id === loop.to) : -1;
  if (target >= 0) flags.push({ key: "loop", label: copy.loopTo(target + 1) });
  return flags.filter(Boolean);
}
