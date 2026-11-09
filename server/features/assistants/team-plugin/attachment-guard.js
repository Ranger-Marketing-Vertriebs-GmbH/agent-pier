import fs from "node:fs";
import path from "node:path";
import { fileSpellings } from "./file-urls.js";
import { fold } from "./managed-folder.js";
import {
  relativeTarget,
  repairs,
  workspaceId,
  writeTargets,
  writeTools,
} from "./guard-paths.js";

// Chat files on an agent shared with users (attachment-access.js). Uploads lie in the
// workspace's attachments/, indexed per chat: a turn uses only its own chat's. What
// OpenClaw keeps beside them names no chat: a channel's photo (and, before 2026.10.9
// and again since 2026.11.2, an image of AgentPier's chat) staged under
// media/inbound/openclaw-staged-<uuid>/,
// and its media store (`<state>/media/`: offloaded uploads as media://inbound/<id>,
// browser screenshots, created images), shared by every agent, which OpenClaw's
// image and pdf tools read even with tools.fs.workspaceOnly. A call naming either
// asks with NO_CHAT, which no chat owns: refused on a shared agent, allowed on any
// other. Other read roots OpenClaw grants (skill folders) hold no chat's files.

/** What a file tool call names in place of a file no chat owns. */
export const NO_CHAT = "media/inbound";
export const attachmentRefusal =
  "Files in attachments/ belong to the chat they were sent in. Use only the files sent in this chat.";
export const noChatRefusal =
  "Files in media/inbound/, media:// references and the Gateway's media store are not available to tools in this chat. Use the files sent in this chat by their attachments/ path.";
const inboundFolder = /(^|\/)media\/inbound(\/|$)/;
const attachmentsFolder = /(^|\/)attachments(\/|$)/;

/**
 * Whether a path value names OpenClaw's inbound media: a media:// reference (also
 * behind the legacy "MEDIA:" prefix OpenClaw strips), or any path through a
 * media/inbound folder, in any case.
 */
export function inboundMedia(value) {
  if (typeof value !== "string") return false;
  const source = value.trim().replace(/^MEDIA\s*:\s*(?!\/\/)/i, "");
  if (/^media:\/\//i.test(source)) return true;
  const normalized = path.posix.normalize(fold(source).replaceAll("\\", "/"));
  return inboundFolder.test(normalized);
}

/**
 * The roots of the Gateway's media store, as written and resolved: below its state
 * folder, by default `state/` beside the workspaces root (runtime-paths.js).
 */
export function mediaStore(stateDir, workspaces) {
  const state =
    typeof stateDir === "string" && path.isAbsolute(stateDir)
      ? stateDir
      : typeof workspaces === "string" && path.isAbsolute(workspaces)
        ? path.join(path.dirname(workspaces), "state")
        : null;
  if (!state) return [];
  const store = path.join(state, "media");
  const roots = [store];
  try {
    roots.push(path.join(fs.realpathSync(state), "media"));
  } catch {}
  return [...new Set(roots)];
}

// A value OpenClaw reads from the web or inline, never from disk.
const remote = (value) => /^\s*(?:https?|data):/i.test(value);

// File tools whose paths may name per-chat files (attachment-access.js) on shared agents.
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
// Whether a path value resolves into the Gateway's media store (`media`: its roots),
// relative to the agent's workspace as OpenClaw's tools resolve it, "~" to HOME.
function inStore(form, media, roots, ownId) {
  let value = form
    .trim()
    .replace(/^MEDIA\s*:\s*(?!\/\/)/i, "")
    .replaceAll("\\", "/");
  if (!media.length || !value || /^(?:@|file:|[a-z][a-z0-9+.-]*:\/\/)/i.test(value))
    return false;
  if (value === "~" || value.startsWith("~/"))
    value = path.posix.join(process.env.HOME || "/", value.slice(1));
  const base = roots[0] && ownId ? path.posix.join(roots[0], ownId) : "/";
  const resolved = fold(path.posix.resolve(base, value));
  return media.some((root) => {
    const store = fold(root);
    return resolved === store || resolved.startsWith(`${store}/`);
  });
}

/**
 * The stored names a call names in the calling agent's attachments/ folder ("" for
 * the folder itself or a path into it not resolved here). With `media` (OpenClaw's
 * guard: the roots of its media store) also NO_CHAT for inbound media or a path into
 * the media store; any other path outside the workspace (OpenClaw's skill folders,
 * for one) is left to OpenClaw's own read roots.
 */
export function attachmentTargets(
  toolName,
  params,
  { roots = [], agentId, media = null } = {},
) {
  const ownId = workspaceId(agentId);
  const chatless = Array.isArray(media);
  const values = writeTools.includes(toolName)
    ? writeTargets(toolName, params).flatMap((p) => [p?.path, p?.file_path, p?.filePath])
    : pathKeys.flatMap((key) =>
        Array.isArray(params?.[key]) ? params[key] : [params?.[key]],
      );
  const files = new Set();
  for (const value of values) {
    if (typeof value !== "string" || (chatless && remote(value))) continue;
    // A file: URL counts as written and as the path OpenClaw decodes from it; "@x"
    // as written and as "x" (repairs).
    for (const form of repairs(value).flatMap(fileSpellings)) {
      if (chatless && (inboundMedia(form) || inStore(form, media, roots, ownId)))
        files.add(NO_CHAT);
      const relative = relativeTarget(form, roots, ownId);
      if (relative) {
        const [first, ...rest] = relative.split("/");
        if (fold(first) === "attachments") files.add(rest.join("/"));
      } else if (attachmentsFolder.test(fold(form.replaceAll("\\", "/")))) files.add("");
    }
  }
  return [...files];
}
/** Lets a file tool call into attachments/ through only as the bridge allows. */
export async function attachmentCall(event, ctx, bridge, roots, media = []) {
  let files;
  try {
    files = attachmentTargets(event?.toolName, event?.params, {
      roots,
      agentId: ctx?.agentId,
      media,
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
  const reason = files.includes(NO_CHAT) ? noChatRefusal : attachmentRefusal;
  return { block: true, blockReason: reason };
}
