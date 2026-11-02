import fs from "node:fs";
import path from "node:path";
import { assistantProblem, textValue } from "./assistant-validation.js";
import {
  attachmentRefusal,
  attachmentTargets,
  browserRefusals,
  classifyWrite,
  writeRefusals,
  writeTargets,
} from "./team-plugin/tool-guard.js";
import { managedRefusal } from "./team-plugin/managed-folder.js";
import { namesSecrets, secretsRefusal } from "./team-plugin/secrets-guard.js";
import { secretsPolicy } from "./agent-hook-bridge.js";
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

// The OpenClaw tool and parameters each Hermes file read corresponds to for the
// attachment and secrets rules (tool-guard.js attachmentTools, secrets-guard.js):
// read_file and search_files read a path, vision_analyze an image.
function readCall(toolName, args) {
  if (toolName === "read_file" || toolName === "search_files")
    return { toolName: "read", params: { path: args.path } };
  if (toolName === "vision_analyze")
    return { toolName: "image", params: { image: args.image_url } };
  return null;
}

const deny = (message) => ({ allow: false, message });

// The session key AgentPier knows the call's chat by: the session's own, or an
// earlier segment before a compression (`segments`, newest first), as long as a chat
// of the agent still holds that one. Leaves `segments` out of the input.
function chatKey(bridge, agent, { sessionKey, segments }) {
  if (segments === undefined) return {};
  if (!Array.isArray(segments) || segments.length > 20) throw assistantProblem("invalid");
  for (const key of segments) textValue(key, 4096);
  const held = new Set(
    (bridge.assistants.store?.listConversations?.() || [])
      .filter((c) => c.assistantId === agent.id && !c.archivedAt)
      .map((c) => c.runtimeSessionKey),
  );
  const known = [sessionKey, ...segments].find((key) => held.has(key));
  return { sessionKey: known || sessionKey, segments: undefined };
}

// The agent's own folder and the roots its paths resolve against, or null.
function rootsOf(bridge, agent) {
  const workspace = agentWorkspace(bridge.assistants.runtime, agent);
  if (!workspace) return null;
  const roots = [path.dirname(workspace)];
  try {
    roots.push(fs.realpathSync(roots[0]));
  } catch {
    /* No folder yet: the plain root only. */
  }
  return { workspace, roots };
}

// A file call naming the agent's attachments/ or its secrets folder asks the bridge
// as OpenClaw's guard does: attachments only from the calling chat, the secrets only
// where the run may read them (a hook run without the hook's Secrets switch may not).
async function folderRefusal(bridge, input, agent, call) {
  const folders = rootsOf(bridge, agent);
  if (!folders) return writeRefusals.unverified;
  const scope = { roots: folders.roots, agentId: input.agentId };
  // A path that cannot be resolved counts as naming the folder (fail closed).
  let files = [""],
    secrets = true;
  try {
    files = attachmentTargets(call.toolName, call.params, scope);
  } catch {
    /* Named. */
  }
  try {
    secrets = namesSecrets(call.params, scope);
  } catch {
    /* Named. */
  }
  const session = input.sessionKey ? { sessionKey: input.sessionKey } : {};
  if (files.length) {
    const policy = input.sessionKey
      ? await bridge.attachmentPolicy({ agentId: input.agentId, ...session, files })
      : null;
    if (policy?.allow !== true) return attachmentRefusal;
  }
  if (secrets) {
    const policy = await secretsPolicy(bridge, { agentId: input.agentId, ...session });
    if (policy?.allow !== true) return secretsRefusal;
  }
  return null;
}

/**
 * The Hermes team plugin's guard (runtimes/hermes/hermes-config/team-plugin.js) asks
 * here before a Hermes agent's browser call, before a file call that names its
 * attachments/ or secrets folder, and before a team member's file change
 * (`memberWrite`), with the rules the OpenClaw tool guard applies
 * (team-plugin/tool-guard.js): the browser runs on the agent's own AgentPier profile
 * (agent-browsers.js); attachments are read only from the chat they came in, the
 * secrets only where the run may (agent-hook-bridge.js secretsPolicy); and a member's
 * file change stays inside its own folder, never touches its instruction files, and
 * is allowed only as the bridge allows the turn (TeamBridge.toolPolicy: the owner's
 * own messages, an owner-proven task). Answers `{ allow }` or `{ allow: false,
 * message }`, the message for the model.
 */
export async function hermesGuard(bridge, input) {
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).some(
      (k) =>
        ![
          "agentId",
          "sessionKey",
          "segments",
          "toolName",
          "args",
          "memberWrite",
        ].includes(k),
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
  input = { ...input, ...chatKey(bridge, agent, input) };
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
  const read = readCall(input.toolName, args);
  const call = writeCall(input.toolName, args);
  const refusal = await folderRefusal(bridge, input, agent, read || call || {});
  if ((read || call) && refusal) return deny(refusal);
  // Only a team member's file changes are checked further (the plugin's guardWrites).
  if (!call || !input.memberWrite) return { allow: true };
  const { workspace, roots } = rootsOf(bridge, agent);
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
