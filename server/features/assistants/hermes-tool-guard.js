import fs from "node:fs";
import path from "node:path";
import { assistantProblem, textValue } from "./assistant-validation.js";
import {
  browserRefusals,
  classifyWrite,
  writeRefusals,
  writeTargets,
} from "./team-plugin/tool-guard.js";
import { managedRefusal } from "./team-plugin/managed-folder.js";
import { agentWorkspace, runtimeIdOf } from "./runtimes/runtime-for.js";

// The OpenClaw tool each Hermes file tool corresponds to for the write rule
// (tool-guard.js writeTools): write_file writes a file, patch edits one, and its V4A
// mode ("patch") is OpenAI's apply_patch format, whose paths patchPaths reads.
function writeCall(toolName, args) {
  if (toolName === "write_file")
    return { toolName: "write", params: { path: args.path } };
  if (toolName !== "patch") return null;
  return args.mode === "patch"
    ? { toolName: "apply_patch", params: { input: args.patch } }
    : { toolName: "edit", params: { path: args.path } };
}

const deny = (message) => ({ allow: false, message });

/**
 * The Hermes team plugin's guard (runtimes/hermes/hermes-config/team-plugin.js) asks
 * here before a Hermes agent's browser call and before a team member's file change,
 * with the rules the OpenClaw tool guard applies (team-plugin/tool-guard.js): the
 * browser runs on the agent's own AgentPier profile (agent-browsers.js), and a file
 * change stays inside the agent's own folder, never touches its instruction files,
 * and is allowed only as the bridge allows the turn (TeamBridge.toolPolicy: the
 * owner's own messages, an owner-proven task). Answers `{ allow }` or `{ allow:
 * false, message }`, the message for the model.
 */
export async function hermesGuard(bridge, input) {
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).some(
      (k) => !["agentId", "sessionKey", "toolName", "args"].includes(k),
    )
  )
    throw assistantProblem("invalid");
  textValue(input.agentId, 512);
  textValue(input.toolName, 128);
  if ("sessionKey" in input) textValue(input.sessionKey, 4096);
  const args =
    input.args && typeof input.args === "object" && !Array.isArray(input.args)
      ? input.args
      : {};
  const agent = bridge.agentOf(input.agentId);
  if (!agent || runtimeIdOf(agent) !== "hermes") return deny(writeRefusals.unauthorized);
  if (input.toolName.startsWith("browser_")) {
    const policy = await bridge.browserPolicy({
      agentId: input.agentId,
      ...(input.sessionKey && { sessionKey: input.sessionKey }),
      action: input.toolName.slice("browser_".length),
    });
    return policy.allow
      ? { allow: true }
      : deny(browserRefusals[policy.reason] || browserRefusals.unavailable);
  }
  const call = writeCall(input.toolName, args);
  if (!call) return { allow: true };
  const workspace = agentWorkspace(bridge.assistants.runtime, agent);
  if (!workspace) return deny(writeRefusals.unverified);
  const roots = [path.dirname(workspace)];
  try {
    roots.push(fs.realpathSync(roots[0]));
  } catch {
    /* No folder yet: the plain root only. */
  }
  const targets = [];
  try {
    for (const params of writeTargets(call.toolName, call.params))
      targets.push(classifyWrite(params, { roots, ownId: path.basename(workspace) }));
  } catch {
    return deny(writeRefusals.unverified);
  }
  if (targets.some((target) => target.outside)) return deny(writeRefusals.outside);
  if (targets.some((target) => target.bootstrap)) return deny(writeRefusals.bootstrap);
  if (targets.some((target) => target.managed)) return deny(managedRefusal);
  if (!input.sessionKey) return deny(writeRefusals.unauthorized);
  for (const target of targets) {
    const policy = await bridge.toolPolicy({
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      toolName: call.toolName,
      path: target.path,
    });
    if (policy?.allow !== true) return deny(writeRefusals.owner);
  }
  return { allow: true };
}
