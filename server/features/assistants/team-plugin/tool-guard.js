import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { patchPaths } from "./patch-paths.js";
import { execEvidence } from "./exec-processes.js";
import { dreamsCall, dreamsTools } from "./dreams-guard.js";
import {
  fold,
  managedFolder,
  managedName,
  managedRefusal,
  reachesManaged,
} from "./managed-folder.js";
export { fold, patchPaths };
// Files OpenClaw loads into every prompt as agent instructions. Native tools may
// never rewrite them; AgentPier owns AGENTS.md and the owner edits USER.md.
export const bootstrapFiles = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
];
// Every file-changing tool in OpenClaw's fs section (2026.10.3 tool catalog: ls,
// read, write, edit, apply_patch). apply_patch is implied wherever write is
// allowed (writeAllowsApplyPatch), so it is guarded like write.
export const writeTools = ["write", "edit", "apply_patch"];
// OpenClaw's own tools that an agent of restricted users never runs (lockedTools in
// native-capabilities.js, less the plugin's tools, whose bridge actions refuse them).
// Every call asks the bridge, so a stale or forged entry that still holds one is
// refused at run time too.
export const lockedCoreTools = [
  "exec",
  "process",
  "session_status",
  "sessions_list",
  "sessions_history",
  "sessions_search",
  "sessions_send",
  "sessions_spawn",
];
// Refuses a locked core tool unless the bridge answers that this agent may run it.
async function lockedToolCall(event, ctx, bridge) {
  const response = await bridge(
    "/tool-policy",
    {
      agentId: ctx?.agentId,
      ...(typeof ctx?.sessionKey === "string" ? { sessionKey: ctx.sessionKey } : {}),
      toolName: event.toolName,
    },
    ctx?.abortSignal,
  ).catch(() => null);
  const policy = response?.ok ? await response.json().catch(() => null) : null;
  if (policy?.allow === true) return undefined;
  return { block: true, blockReason: "This agent may not use this tool." };
}
// Why the step hook refused a tool call, for the model: only the bridge's own
// memory-step answer names the memory step; no answer (unreachable, timeout, an
// error status, a closing bridge) says AgentPier could not confirm the call.
export const stepRefusals = {
  memoryStep: "A memory step only saves the agent's memory.",
  unavailable: "AgentPier is not reachable right now; try again shortly.",
};
// Every tool call asks whether it runs in a memory step, which keeps to its memory
// tools (memory-step-tools.js); an unanswered question refuses.
// A memory step is an agent run (chat.send) and always names its agent; a call of
// no agent (an internal run) is no step's.
export async function stepCall(event, ctx, bridge) {
  if (typeof ctx?.agentId !== "string" || !ctx.agentId) return undefined;
  const response = await bridge(
    "/step-policy",
    {
      agentId: ctx?.agentId,
      ...(typeof ctx?.sessionKey === "string" ? { sessionKey: ctx.sessionKey } : {}),
      ...(typeof ctx?.runId === "string" ? { runId: ctx.runId } : {}),
      toolName: event?.toolName,
    },
    ctx?.abortSignal,
  ).catch(() => null);
  const policy = response?.ok ? await response.json().catch(() => null) : null;
  if (policy?.allow === true) return undefined;
  return {
    block: true,
    blockReason:
      policy?.reason === "memoryStep"
        ? stepRefusals.memoryStep
        : stepRefusals.unavailable,
  };
}
/** The tool call's targets, each as classifyWrite sees a single-path call. */
export function writeTargets(toolName, params) {
  if (toolName !== "apply_patch") return [params];
  const paths = patchPaths(params?.input);
  return paths ? paths.map((target) => ({ path: target })) : [{}];
}
// Must stay below AgentPier's tolerance for a missing report after reconnecting.
export const guardReportMs = 15000;
const protectedNames = new Set(bootstrapFiles.map(fold));
// The OpenClaw 2026.10.3 file tools repair model-corrupted paths after this hook runs
// (agent-tools.before-tool-call.decision: XML arg_value suffix, Office extensions);
// every repaired spelling is classified, not only the raw one.
export function repairs(value) {
  const forms = new Set([value, value.trim()]);
  for (const form of [...forms]) {
    let stripped = form;
    while (/<\/arg_value>>+$/.test(stripped))
      stripped = stripped.replace(/<\/arg_value>>+$/, "");
    forms.add(stripped);
  }
  for (const form of [...forms]) {
    forms.add(
      form.replace(
        /\.(doc|ppt|xls)(?:odex|codex|xodex|xcodex)$/i,
        (_m, family) => `.${family.toLowerCase()}x`,
      ),
    );
    // OpenClaw resolves "@name" to "name" when no literal "@name" exists.
    if (form.startsWith("@")) forms.add(form.slice(1));
  }
  return [...forms];
}
// The agent's own workspace folder below the workspaces root (runtime id ap-<id>).
export const workspaceId = (agentId) =>
  typeof agentId === "string" && /^ap-[A-Za-z0-9-]{1,100}$/.test(agentId)
    ? agentId.slice(3)
    : null;
// Workspace-relative POSIX path, or null when the target cannot be proven to stay
// inside the calling agent's own workspace.
function relativeTarget(raw, roots, ownId) {
  // No workspace file needs a control or line-separator character; a path holding
  // one may be read differently by another parser, so it is never a target.
  if (!raw || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(raw)) return null;
  let target = raw.replaceAll("\\", "/");
  if (!target || /^(@|~|file:)/i.test(target)) return null;
  if (path.posix.isAbsolute(target)) {
    const inside = roots
      .map((root) => path.posix.relative(root, path.posix.normalize(target)))
      .find((rel) => rel && !rel.startsWith("../") && rel !== "..");
    const [own, ...rest] = inside?.split("/") || [];
    // A sibling agent's workspace is never a valid target.
    if (!ownId || own !== ownId) return null;
    target = rest.join("/");
    if (!target) return null;
  }
  target = path.posix
    .normalize(target)
    .replace(/^(\.\/)+/, "")
    .replace(/\/$/, "");
  if (!target || target === "." || target.startsWith("../") || target === "..")
    return null;
  return target;
}
// Root-level names must be plain ASCII so no Unicode fold can reach a bootstrap file.
// Workspace skill folders are loaded into the prompt like bootstrap files, and a
// bootstrap name must never become a directory either.
const protectedFolders = new Set(["skills", ".agents"]);
const plainRootName = /^[A-Za-z0-9 ._()+,-]+$/;
function protectedName(relative) {
  const [first, ...rest] = relative.split("/");
  return (
    !plainRootName.test(first) ||
    protectedNames.has(fold(first)) ||
    (rest.length > 0 && protectedFolders.has(fold(first)))
  );
}
/**
 * Whether a top-level workspace entry is one native file tools never write (a
 * bootstrap file, a skill folder, .agentpier/, a name a fold could turn into one) or
 * reach only through the attachment policy (attachments/). AgentPier's own transfers
 * into and out of a workspace (agent-sftp-local.js) keep away from all of them.
 */
export const guardedWorkspaceEntry = (name) =>
  !plainRootName.test(name) ||
  protectedNames.has(fold(name)) ||
  protectedFolders.has(fold(name)) ||
  fold(name) === "attachments" ||
  fold(name) === managedFolder;
// Identity of every on-disk bootstrap file, so links and case variants are caught.
function protectedTargets(workspace) {
  const ids = new Set();
  for (const name of fs.readdirSync(workspace))
    if (protectedNames.has(fold(name)))
      try {
        const stat = fs.statSync(path.join(workspace, name));
        ids.add(`${stat.dev}:${stat.ino}`);
      } catch {}
  return ids;
}
export function classifyWrite(params, { roots = [], agentId } = {}) {
  const ownId = workspaceId(agentId);
  const values = [params?.path, params?.file_path, params?.filePath].filter(
    (value) => typeof value === "string",
  );
  if (!values.length || !ownId || !roots.length) return { outside: true };
  const targets = values.flatMap(repairs).map((v) => relativeTarget(v, roots, ownId));
  if (targets.some((t) => !t)) return { outside: true };
  if (targets.some(protectedName)) return { bootstrap: true };
  if (targets.some(managedName)) return { managed: true };
  let workspace;
  try {
    workspace = fs.realpathSync(path.join(roots[0], ownId));
  } catch {
    // No workspace yet: nothing on disk can alias a bootstrap file.
    return { path: targets[0] };
  }
  if (targets.some((target) => reachesManaged(workspace, target)))
    return { managed: true };
  const ids = protectedTargets(workspace);
  for (const target of targets)
    try {
      const stat = fs.statSync(path.join(workspace, target));
      if (ids.has(`${stat.dev}:${stat.ino}`)) return { bootstrap: true };
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return { outside: true };
    }
  return { path: targets[0] };
}
// File tools whose paths may name the agent's attachments/ folder, and their path
// parameters. On a shared agent a turn uses only its own chat's uploads there
// (attachment-access.js); every call naming the folder asks the bridge.
export const attachmentTools = [
  "read",
  "memory_get",
  "pdf",
  // Read images grants view_image (native-capabilities.js); older names stay matched.
  "view_image",
  "image",
  "image_generate",
  ...writeTools,
];
const pathKeys = ["path", "file_path", "filePath", "pdf", "pdfs", "image", "images"];
const attachmentsFolder = /(^|\/)attachments(\/|$)/;
/**
 * The stored names a call names in the calling agent's attachments/ folder (""
 * for the folder itself, or for a path into it that cannot be resolved here).
 */
export function attachmentTargets(toolName, params, { roots = [], agentId } = {}) {
  const ownId = workspaceId(agentId);
  const values = writeTools.includes(toolName)
    ? writeTargets(toolName, params).flatMap((p) => [p?.path, p?.file_path, p?.filePath])
    : pathKeys.flatMap((key) =>
        Array.isArray(params?.[key]) ? params[key] : [params?.[key]],
      );
  const files = new Set();
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const form of repairs(value)) {
      const relative = relativeTarget(form, roots, ownId);
      if (relative) {
        const [first, ...rest] = relative.split("/");
        if (fold(first) === "attachments") files.add(rest.join("/"));
      } else if (attachmentsFolder.test(fold(form.replaceAll("\\", "/")))) files.add("");
    }
  }
  return [...files];
}
export const attachmentRefusal =
  "Files in attachments/ belong to the chat they were sent in. Use only the files sent in this chat.";
/** Lets a file tool call into attachments/ through only as the bridge allows. */
export async function attachmentCall(event, ctx, bridge, roots) {
  let files;
  try {
    files = attachmentTargets(event?.toolName, event?.params, {
      roots,
      agentId: ctx?.agentId,
    });
  } catch {
    files = [""];
  }
  if (!files.length) return undefined;
  const response =
    typeof ctx?.sessionKey === "string"
      ? await bridge(
          "/attachment-policy",
          { agentId: ctx?.agentId, sessionKey: ctx.sessionKey, files },
          ctx?.abortSignal,
        ).catch(() => null)
      : null;
  const policy = response?.ok ? await response.json().catch(() => null) : null;
  if (policy?.allow === true) return undefined;
  return { block: true, blockReason: attachmentRefusal };
}
// Why AgentPier refused a browser call (agent-browsers.js policy), for the model.
export const browserRefusals = {
  unavailable: "The browser is not available right now. Try again later.",
  notGranted: "This agent may not use a browser.",
  importBlocked: "Importing a system browser profile is not allowed.",
  restartNeeded:
    "This agent's browser profile is not set up yet; the owner must restart the agent service.",
  slotsBusy: "All browser profiles for team members are in use. Try again later.",
  ownerControl:
    "The owner is using this browser right now (for example to sign in or solve a check). Wait until the owner hands it back; you will get a message then. Do not retry the browser meanwhile.",
  // A user agent's browser held by its user (the owner neither drives nor reads it).
  userControl:
    "Your user is using this browser right now (for example to sign in or solve a check). Wait until your user hands it back; you will get a message then. Do not retry the browser meanwhile.",
  sharedUserControl:
    "A user of this agent is using this browser right now (for example to sign in or solve a check). Wait until it is handed back; you will get a message then. Do not retry the browser meanwhile.",
  visibleLimit:
    "Three visible agent browsers are already in use. Try again in a minute or ask the owner.",
  // A browser upload of a file AgentPier did not stage for this agent
  // (agent-browser-uploads.js).
  uploadNotStaged:
    "Upload only a file AgentPier staged for you: call agentpier_workspace with action browser_upload_stage (path, and projectId for a project folder) and pass the uploadPath it returns unchanged. A staged file expires after six hours; stage it again then.",
  uploadOutside:
    "Your browser cannot upload this file from where it is. Call agentpier_workspace with action browser_upload_stage for a file in your own workspace or in a project folder you may read, then pass the uploadPath it returns. Files outside those folders cannot be uploaded.",
};
/**
 * Pins every browser call to the calling agent's own profile on the Gateway host;
 * AgentPier refuses it, with a reason, otherwise. Fails closed.
 */
export async function browserCall(event, ctx, bridge) {
  const action =
    typeof event?.params?.action === "string" ? event.params.action : undefined;
  const response = await bridge(
    "/browser-policy",
    {
      agentId: ctx?.agentId,
      // The calling turn: its person may watch and take over the browser.
      ...(typeof ctx?.sessionKey === "string" && { sessionKey: ctx.sessionKey }),
      ...(action && { action }),
      // An upload names its files, which AgentPier checks (agent-browser-uploads.js).
      ...(action?.trim().toLowerCase() === "upload" && {
        paths: Array.isArray(event.params.paths) ? event.params.paths.map(String) : [],
      }),
    },
    ctx?.abortSignal,
  ).catch(() => null);
  const policy = response?.ok ? await response.json().catch(() => null) : null;
  if (policy?.allow !== true || typeof policy.profile !== "string")
    return {
      block: true,
      blockReason: browserRefusals[policy?.reason] || browserRefusals.unavailable,
    };
  return { params: { ...event.params, profile: policy.profile, target: "host" } };
}
/**
 * Reports a browser upload's outcome (after_tool_call) to AgentPier, which records it
 * for the agent's own staged files (agent-browser-uploads.js). Best effort.
 */
export async function browserUploaded(event, ctx, bridge) {
  const action = event?.params?.action;
  if (event?.toolName !== "browser" || typeof action !== "string") return;
  if (action.trim().toLowerCase() !== "upload" || !Array.isArray(event.params.paths))
    return;
  const failed =
    !!event.error ||
    // OpenClaw's tool error, also as the text of a result's content.
    /\\*"status\\*"\s*:\s*\\*"error/.test(JSON.stringify(event.result ?? null));
  await bridge("/browser-upload", {
    agentId: ctx?.agentId,
    ...(typeof ctx?.sessionKey === "string" && { sessionKey: ctx.sessionKey }),
    paths: event.params.paths.map(String).slice(0, 20),
    ok: !failed,
  }).catch(() => null);
}
// Why an image_generate call was refused (image-policy.js), for the model.
export const imageRefusals = {
  // Neutral: on an agent of users the person in the chat is not the owner.
  unavailable:
    "Image creation is not available right now. Say so plainly in this chat; do not retry.",
  notGranted: "This agent may not create images.",
  model:
    "Only OpenAI image models (openai/gpt-image-...) are available. Leave model unset.",
  reference:
    "Give reference images as paths to files in your workspace, or as a list of such paths.",
  remote:
    "Reference images from web addresses need the 'Read web pages' capability. Use a file in your workspace instead.",
};
const imageModel = /^openai\/gpt-image-[A-Za-z0-9._-]+$/;
// Any scheme but inline data reaches beyond the workspace (OpenClaw fetches http(s)
// references itself; loadMediaToolReferences).
const remoteReference = (value) =>
  /^[a-z][a-z0-9+.-]*:/i.test(value.trim()) && !/^data:/i.test(value.trim());
/**
 * Lets an image_generate call through only for an agent that may create images now,
 * with the OpenAI model; a reference from the web needs the agent's web reading as
 * well, or the tool would carry data out. Fails closed.
 */
export async function imageCall(event, ctx, bridge) {
  const params = event?.params || {};
  const block = (reason) => ({ block: true, blockReason: imageRefusals[reason] });
  if (
    params.model !== undefined &&
    !(typeof params.model === "string" && imageModel.test(params.model.trim()))
  )
    return block("model");
  const references = [
    ...(params.image === undefined ? [] : [params.image]),
    ...(params.images === undefined
      ? []
      : Array.isArray(params.images)
        ? params.images
        : [null]),
  ];
  if (references.some((value) => typeof value !== "string")) return block("reference");
  const response = await bridge(
    "/image-policy",
    {
      agentId: ctx?.agentId,
      sessionKey: ctx?.sessionKey,
      action: typeof params.action === "string" ? params.action : "generate",
      remote: references.some(remoteReference),
    },
    ctx?.abortSignal,
  ).catch(() => null);
  const policy = response?.ok ? await response.json().catch(() => null) : null;
  if (policy?.allow === true) return undefined;
  return block(imageRefusals[policy?.reason] ? policy.reason : "unavailable");
}
// Why a pdf call was refused, for the model.
export const pdfRefusals = {
  unavailable: "Reading PDFs is not available right now. Say so plainly; do not retry.",
  notGranted: "This agent may not read PDFs.",
  reference: "Give PDFs as paths to files in your workspace, without a web address.",
};
/**
 * Lets a pdf call through only with workspace files (OpenClaw fetches http(s)
 * references itself, which would reach the web without the agent's web capabilities;
 * local paths stay within the workspace, tools.fs.workspaceOnly) and sets `model` to
 * the one AgentPier names for the calling agent (pdf-policy.js): OpenClaw would
 * otherwise read with the global agents.defaults.pdfModel. A `model` the agent passes
 * is replaced, never used. Fails closed.
 */
export async function pdfCall(event, ctx, bridge) {
  const params = event?.params || {};
  const block = (reason) => ({ block: true, blockReason: pdfRefusals[reason] });
  const references = [
    ...(params.pdf === undefined ? [] : [params.pdf]),
    ...(params.pdfs === undefined
      ? []
      : Array.isArray(params.pdfs)
        ? params.pdfs
        : [null]),
  ];
  if (
    references.some(
      (value) => typeof value !== "string" || /^[a-z][a-z0-9+.-]*:/i.test(value.trim()),
    )
  )
    return block("reference");
  const response = await bridge(
    "/pdf-policy",
    {
      agentId: ctx?.agentId,
      ...(typeof ctx?.sessionKey === "string" && { sessionKey: ctx.sessionKey }),
    },
    ctx?.abortSignal,
  ).catch(() => null);
  const policy = response?.ok ? await response.json().catch(() => null) : null;
  if (policy?.allow !== true || typeof policy.model !== "string" || !policy.model)
    return block(
      Object.hasOwn(pdfRefusals, policy?.reason) ? policy.reason : "unavailable",
    );
  return { params: { ...params, model: policy.model } };
}
export function registerToolGuard(api) {
  const configured = api.pluginConfig?.workspaces;
  const roots =
    typeof configured === "string" && path.isAbsolute(configured) ? [configured] : [];
  try {
    if (roots.length) roots.push(fs.realpathSync(roots[0]));
  } catch {}
  const bridge = (endpoint, body, signal) =>
    fetch(api.pluginConfig.url + endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${api.pluginConfig.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    });
  // Setup and metadata loads have no hook surface; registration must never throw.
  if (typeof api.on !== "function") return null;
  api.on(
    "before_tool_call",
    async (event, ctx) => {
      const deny = (blockReason) => ({ block: true, blockReason });
      const targets = [];
      try {
        for (const params of writeTargets(event.toolName, event.params))
          targets.push(classifyWrite(params, { roots, agentId: ctx?.agentId }));
      } catch {
        return deny("The write target could not be verified.");
      }
      if (targets.some((target) => target.outside))
        return deny("Writes are limited to this agent's workspace.");
      if (targets.some((target) => target.bootstrap))
        return deny("Agent instruction files are managed by AgentPier.");
      if (targets.some((target) => target.managed)) return deny(managedRefusal);
      if (!ctx?.sessionKey) return deny("This turn is not authorized to change files.");
      // The bridge alone knows whether the current turn came directly from the owner;
      // every path of a patch must be allowed.
      for (const target of targets) {
        const response = await bridge(
          "/tool-policy",
          {
            agentId: ctx.agentId,
            sessionKey: ctx.sessionKey,
            toolName: event.toolName,
            path: target.path,
            // Pins a memory flush to its own run (memory-flushes.js).
            ...(typeof ctx.runId === "string" ? { runId: ctx.runId } : {}),
            // A command completion's run proves its owner turn (exec-continuation.js).
            exec: execEvidence(ctx.sessionKey, ctx.runId),
          },
          ctx.abortSignal,
        ).catch(() => null);
        const policy = response?.ok ? await response.json().catch(() => null) : null;
        if (policy?.allow !== true)
          return deny("Only the owner's own messages may change files.");
      }
      return undefined;
    },
    { matcher: writeTools, priority: 1000 },
  );
  api.on("before_tool_call", (event, ctx) => stepCall(event, ctx, bridge), {
    priority: 1000,
  });
  api.on("before_tool_call", (event, ctx) => lockedToolCall(event, ctx, bridge), {
    matcher: lockedCoreTools,
    priority: 1000,
  });
  api.on("before_tool_call", (event, ctx) => browserCall(event, ctx, bridge), {
    matcher: ["browser"],
    priority: 1000,
  });
  api.on("after_tool_call", (event, ctx) => browserUploaded(event, ctx, bridge));
  api.on("before_tool_call", (event, ctx) => imageCall(event, ctx, bridge), {
    matcher: ["image_generate"],
    priority: 1000,
  });
  api.on("before_tool_call", (event, ctx) => attachmentCall(event, ctx, bridge, roots), {
    matcher: attachmentTools,
    priority: 1000,
  });
  api.on("before_tool_call", (event) => dreamsCall(event), {
    matcher: dreamsTools,
    priority: 1000,
  });
  api.on("before_tool_call", (event, ctx) => pdfCall(event, ctx, bridge), {
    matcher: ["pdf"],
    priority: 1000,
  });
  // Only after the hook is registered, and only from the active Gateway runtime
  // registry: discovery loads never carry the hooks agent runs use.
  if (api.registrationMode !== "full") return null;
  // A managed plugin instance aborts lifecycle.signal when OpenClaw retires it
  // (plugin replacement, reload, Gateway close); a retired registry never reports.
  const signal = api.lifecycle?.signal;
  const instance = randomUUID();
  let timer = null;
  const stop = () => {
    clearInterval(timer);
    timer = null;
  };
  const report = () => {
    if (signal?.aborted) return stop();
    return bridge("/guard", { pid: process.pid, ppid: process.ppid, instance }).catch(
      () => null,
    );
  };
  // AgentPier withdraws the guard whenever its connection leaves ready, so the
  // report repeats, but only while this instance can prove it is still active.
  if (signal instanceof AbortSignal && !signal.aborted) {
    const interval = api.pluginConfig?.guardReportMs;
    timer = setInterval(
      report,
      Number.isSafeInteger(interval) && interval >= 1000 ? interval : guardReportMs,
    );
    timer.unref?.();
    signal.addEventListener("abort", stop, { once: true });
    api.lifecycle.onDispose?.(stop);
  }
  api.on("gateway_stop", stop);
  return report();
}
