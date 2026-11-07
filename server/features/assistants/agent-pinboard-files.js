import { createHash } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import { openShareSource, projectShareTarget, shareRoots } from "./agent-share-source.js";
import { VIDEO_HEAD_BYTES, videoMetadata, videoType } from "./agent-video-types.js";
import { audioType } from "./agent-audio-types.js";
import {
  INLINE_IMAGE_TYPES,
  MAX_ATTACHMENT_BYTES,
  detectAttachment,
} from "./agent-attachment-types.js";

// Files up to this size are recognised by their bytes (a touch keeps them unchanged);
// larger ones by size, modification time and inode.
export const PIN_HASH_MAX_BYTES = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const download = { type: "application/octet-stream", kind: "file" };

/**
 * Opens a pinned file with the share rules (agent-share-source.js) on every read:
 * `root` "workspace" is the agent's own workspace, "project:<id>" a project folder
 * granted to it. A pin passes the turn as `scope` (a hook or routine pins only where
 * it could share); the owner's reads pass none and use the agent's standing grants.
 * Returns `{ name, relative, handle, size, stat }`; the caller closes `handle`.
 */
export async function openPinned(
  assistants,
  agent,
  { root, path },
  { admit, scope = null } = {},
) {
  let opened;
  if (root === "workspace") {
    opened = await openShareSource(
      shareRoots(assistants.attachments.config?.workspaces, agent),
      path,
      { admit },
    );
  } else if (typeof root === "string" && root.startsWith("project:")) {
    const target = projectShareTarget(
      assistants,
      agent,
      { projectId: root.slice("project:".length), path },
      scope,
    );
    // A stored path names the file as it was resolved at pin time: a link that
    // appeared on the way since (even one inside the folder) is refused.
    if (!scope && target.relative !== path) throw assistantProblem("shareOutside", 403);
    opened = await openShareSource(target.roots, target.relative, {
      refuseDirs: target.refuseDirs,
    });
  } else throw assistantProblem("invalid");
  if (opened.stat.size === 0n) {
    await opened.handle.close();
    throw assistantProblem("shareEmpty", 400);
  }
  return { ...opened, size: Number(opened.stat.size) };
}

// Up to `length` bytes from `offset` of the descriptor.
async function readAt(handle, offset, length) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
    if (!bytesRead) break;
    read += bytesRead;
  }
  return buffer.subarray(0, read);
}

const plain = (value) =>
  value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : String(value);

/** Size, modification time and inode of a (bigint) stat, as a pin's identity keeps them. */
export const statIdentity = (stat) => ({
  size: Number(stat.size),
  mtimeMs: plain(stat.mtimeMs),
  ino: plain(stat.ino),
});

/** Which file a pin shows: size, modification time, inode, and the bytes' hash when small. */
export async function pinIdentity(handle, stat) {
  const identity = statIdentity(stat);
  const { size } = identity;
  if (size > PIN_HASH_MAX_BYTES) return identity;
  const hash = createHash("sha256");
  for (let offset = 0; offset < size;) {
    const chunk = await readAt(handle, offset, Math.min(CHUNK_BYTES, size - offset));
    if (!chunk.length) break;
    hash.update(chunk);
    offset += chunk.length;
  }
  return { ...identity, hash: hash.digest("hex") };
}

/** Whether two identities name the same content (stored extras such as `type` aside). */
export function sameIdentity(a, b) {
  if (!a || !b) return false;
  if (a.hash && b.hash) return a.hash === b.hash;
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

/**
 * How the owner's app shows a pinned file, from its bytes: video (with its duration
 * when the container states it), audio, an image the browser renders inline,
 * Markdown by name; anything else (HEIC included) is a download.
 */
export async function pinType(handle, size, name) {
  const head = await readAt(handle, 0, Math.min(VIDEO_HEAD_BYTES, size));
  const video = videoType(head);
  if (video) {
    const metadata = await videoMetadata(
      video,
      (offset, length) =>
        readAt(handle, offset, Math.max(0, Math.min(length, size - offset))),
      size,
    );
    return {
      type: video,
      kind: "video",
      ...(Number.isFinite(metadata?.duration) ? { duration: metadata.duration } : {}),
    };
  }
  const audio = audioType(head);
  if (audio) return { type: audio, kind: "audio" };
  if (size <= MAX_ATTACHMENT_BYTES) {
    const detected = detectAttachment(await readAt(handle, 0, size), name);
    if (detected?.kind === "image")
      return INLINE_IMAGE_TYPES.has(detected.type)
        ? { type: detected.type, kind: "image" }
        : download;
  }
  if (/\.(md|markdown)$/i.test(name)) return { type: "text/markdown", kind: "text" };
  return download;
}
