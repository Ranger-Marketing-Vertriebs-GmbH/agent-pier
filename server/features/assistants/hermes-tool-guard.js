import fs from "node:fs";
import path from "node:path";
import { assistantProblem, textValue } from "./assistant-validation.js";
import {
  attachmentRefusal,
  attachmentTargets,
  browserRefusals,
  classifyWrite,
  imageRefusals,
  pdfRefusals,
  writeRefusals,
  writeTargets,
} from "./team-plugin/tool-guard.js";
import { managedRefusal } from "./team-plugin/managed-folder.js";
import { namesSecrets, secretsRefusal } from "./team-plugin/secrets-guard.js";
import { secretsPolicy } from "./agent-hook-bridge.js";
import { agentWorkspace, runtimeIdOf } from "./runtimes/runtime-for.js";
import {
  chatFilesRefusal,
  chatFolderRefusal,
  homeRefusal,
  readValues,
  searchCovers,
  splitSearchRefusal,
  splitsSearch,
  userReadRefusal,
} from "./hermes-home-guard.js";
import { agentChatPath, chatFolderPath } from "./chat-file-folders.js";
import { isShared } from "../users/user-access.js";
import { OLD_IMAGES, leftoverImages } from "./hermes-image-migration.js";

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

// The calling chat of a guarded call, when it is one of the agent's: its id and its
// file folder (chat-file-folders.js); a session bound to several turns has none.
function callingChat(bridge, agent, input) {
  const config = bridge.assistants.attachments?.config;
  try {
    if (!input.sessionKey || bridge.bound?.(input.sessionKey)?.length > 1) return {};
    const { conversation } = bridge.callingChat(input);
    if (conversation?.assistantId !== agent.id) return {};
    return {
      id: conversation.id,
      folder: chatFolderPath(config, agent.id, conversation.id),
    };
  } catch {
    return {};
  }
}

// The file folders a pdf or image reference, and on an agent of restricted users a
// file read or write, may come from besides the work folder: the calling chat's on a shared
// agent, every chat's of the agent otherwise.
const chatRoots = (bridge, agent, input) =>
  [
    isShared(agent)
      ? callingChat(bridge, agent, input).folder
      : agentChatPath(bridge.assistants.attachments?.config, agent.id),
  ].filter(Boolean);
// Whether `target` (and, when given, its `real` path) lies in one of `roots` as
// configured or as resolved.
function insideRoots(roots, target, real) {
  const forms = roots.flatMap((root) => {
    try {
      return [root, fs.realpathSync(root)];
    } catch {
      return [root];
    }
  });
  return (
    forms.some((root) => within(root, target)) &&
    (!real || forms.some((root) => within(root, real)))
  );
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

// Hermes's image_generate (tools/image_generation_tool.py) takes a source image
// (`image_url`) and references (`reference_image_urls`): web addresses, data URLs or
// local paths, which the openai-codex backend reads itself and sends to OpenAI.
const imageReferences = (args) => [
  ...(args.image_url === undefined ? [] : [args.image_url]),
  ...(args.reference_image_urls === undefined
    ? []
    : Array.isArray(args.reference_image_urls)
      ? args.reference_image_urls
      : [null]),
];
const within = (root, target) => {
  const relative = path.relative(root, target);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
};
const scheme = (value) => /^[a-z][a-z0-9+.-]*:/i.test(value.trim());
// Hermes resolves a relative path against its own process, not the work folder.
const localRefusal =
  "Give reference images as absolute paths to files in your work folder or this chat's file folder, or as web addresses.";

// An image_generate call, as OpenClaw's guard judges it (tool-guard.js imageCall,
// image-policy.js): the agent may create images now, a web reference needs Read web
// pages, a local one is a file of its own folder (never its attachments from another
// chat or its secrets); each generation is audited.
async function imageGuard(bridge, input, agent, args) {
  const references = imageReferences(args);
  if (references.some((value) => typeof value !== "string" || !value.trim()))
    return deny(imageRefusals.reference);
  const local = references.filter((value) => !scheme(value));
  const folders = local.length ? rootsOf(bridge, agent) : null;
  const roots = folders ? [folders.workspace, ...chatRoots(bridge, agent, input)] : [];
  for (const value of local) {
    if (!path.isAbsolute(value) || !folders) return deny(localRefusal);
    let real = null;
    try {
      real = fs.realpathSync(value);
    } catch {
      /* A missing file fails in Hermes; its spelled path is judged. */
    }
    // The path as spelled, and for an existing file as resolved, stays in its folder
    // or a chat's file folder.
    if (!insideRoots(roots, value, real)) return deny(localRefusal);
    const refusal = await folderRefusal(bridge, input, agent, {
      toolName: "image",
      params: { image: value },
    });
    if (refusal) return deny(refusal);
  }
  const policy = bridge.assistants.imagePolicy?.check({
    agentId: input.agentId,
    ...(input.sessionKey && { sessionKey: input.sessionKey }),
    remote: references.some((value) => scheme(value) && !/^data:/i.test(value.trim())),
  });
  if (policy?.allow === true) return { allow: true };
  return deny(imageRefusals[policy?.reason] || imageRefusals.unavailable);
}

// PDFs a pdf call reads at most, as OpenClaw's pdf tool (hermes-config/pdf.js offers
// the same limit in the tool's schema).
const pdfLimit = 10;
// The PDFs a pdf call names (`pdf` and `pdfs`, as OpenClaw's pdf tool takes them).
const pdfReferences = (args) => [
  ...(args.pdf === undefined ? [] : [args.pdf]),
  ...(args.pdfs === undefined ? [] : Array.isArray(args.pdfs) ? args.pdfs : [null]),
];

// A pdf call, as OpenClaw's guard judges one (tool-guard.js pdfCall) and as this
// guard judges a file read: files of the agent's own folder only (a relative path
// from that folder, where the tool resolves it too), never a web address, its
// attachments from another chat or its secrets; then the model that reads
// (pdf-policy.js reader): `{ allow: true, reader }` tells the tool which one.
async function pdfGuard(bridge, input, agent, args) {
  const references = pdfReferences(args);
  if (
    !references.length ||
    references.length > pdfLimit ||
    references.some(
      (value) => typeof value !== "string" || !value.trim() || scheme(value),
    )
  )
    return deny(pdfRefusals.reference);
  const folders = rootsOf(bridge, agent);
  if (!folders) return deny(pdfRefusals.unavailable);
  const own = folders.workspace;
  const roots = [own, ...chatRoots(bridge, agent, input)];
  const files = [];
  for (const value of references) {
    const target = path.resolve(own, value);
    let real = null;
    try {
      real = fs.realpathSync(target);
    } catch {
      /* A missing file fails in the tool; its spelled path is judged. */
    }
    if (!insideRoots(roots, target, real)) return deny(pdfRefusals.reference);
    // The attachment and secrets rules judge the file a link points at as well.
    files.push(target, ...(real && real !== target ? [real] : []));
  }
  const refusal = await folderRefusal(bridge, input, agent, {
    toolName: "pdf",
    params: { pdfs: files },
  });
  if (refusal) return deny(refusal);
  const policy = await bridge.assistants.pdfPolicy?.reader({
    agentId: input.agentId,
    ...(input.sessionKey && { sessionKey: input.sessionKey }),
  });
  if (policy?.allow === true)
    return {
      allow: true,
      reader: policy.reader,
      ...(typeof policy.fallback === "string" && { fallback: policy.fallback }),
    };
  return deny(pdfRefusals[policy?.reason] || pdfRefusals.unavailable);
}

// A file call's checks of hermes-home-guard.js: an agent of restricted users reads and
// writes only its work folder and its chat folders (a shared one only the calling
// chat's);
// any agent's file calls into the chat folders stay in its own (a shared agent's in
// the calling chat's); and a search over its secrets folder is a read of the secrets.
async function chatGuard(bridge, input, agent, args, call) {
  const runtime = bridge.assistants.runtime;
  const chat = callingChat(bridge, agent, input);
  const reads = readValues(input.toolName, args);
  const search = input.toolName === "search_files";
  if (search && reads.some(splitsSearch)) return splitSearchRefusal;
  let values = reads;
  if (call) {
    const targets = writeTargets(call.toolName, call.params);
    if (
      targets.some((t) => typeof t?.path !== "string") &&
      /chat-files/i.test(JSON.stringify(args))
    )
      return chatFilesRefusal;
    values = targets.map((t) => t?.path);
  }
  const userRefusal = () =>
    userReadRefusal(runtime, agent, values, chatRoots(bridge, agent, input));
  const own = reads && userRefusal();
  if (own) return own;
  const config = bridge.assistants.attachments?.config;
  const refusal = chatFolderRefusal(runtime, agent, config, chat.id ?? null, values);
  if (refusal) return refusal;
  // Writes as well (after the clearer refusal for another chat's folder): patch shows
  // the lines of a file it cannot match.
  const write = call && userRefusal();
  if (write) return write;
  // On a shared agent a search never covers an attachments/ left in its work folder:
  // it holds files of every chat until they moved (chat-file-migration.js).
  if (search && isShared(agent) && searchCovers(runtime, agent, reads, "attachments"))
    return homeRefusal;
  // Nor does any read reach an image an older AgentPier created that has not moved
  // yet (hermes-image-migration.js).
  const shared = reads && isShared(agent);
  if (shared && searchCovers(runtime, agent, reads, OLD_IMAGES, leftoverImages))
    return homeRefusal;
  if (search && searchCovers(runtime, agent, reads)) {
    const session = input.sessionKey ? { sessionKey: input.sessionKey } : {};
    const policy = await secretsPolicy(bridge, { agentId: input.agentId, ...session });
    if (policy?.allow !== true) return secretsRefusal;
  }
  return null;
}

/**
 * The Hermes team plugin's guard (runtimes/hermes/hermes-config/team-plugin.js) asks
 * here before a Hermes agent's browser call, before its image_generate call
 * (imageGuard), at each call of AgentPier's pdf tool (pdfGuard), before a file call
 * that names its
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
  if (input.toolName === "image_generate") return imageGuard(bridge, input, agent, args);
  if (input.toolName === "pdf") return pdfGuard(bridge, input, agent, args);
  const read = readCall(input.toolName, args);
  const call = writeCall(input.toolName, args);
  const chatRefusal =
    (read || call) && (await chatGuard(bridge, input, agent, args, call));
  if (chatRefusal) return deny(chatRefusal);
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
