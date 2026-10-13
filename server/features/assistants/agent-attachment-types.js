import path from "node:path";
import { rasterType } from "../chat/chat-image-probe.js";

// What the owner may attach to an agent message. The browser applies the same
// limits first; the server decides by the bytes, never by a name or a client type.
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
// OpenClaw 2026.9.8 refuses inline chat images above 6 MiB (MAX_IMAGE_BYTES) and
// carries one RPC frame of at most 25 MiB; base64 adds a third. Images beyond either
// budget reach the agent only through the workspace copy.
export const MAX_INLINE_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_INLINE_TOTAL_BYTES = 15 * 1024 * 1024;
// The image types a model receives inline; HEIC stays a workspace file.
export const INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const textExtensions = new Set(
  (
    "txt text md markdown log json jsonl ndjson yaml yml toml ini conf cfg config " +
    "properties csv tsv xml html htm css scss less js mjs cjs jsx ts tsx py rb go rs " +
    "java kt kts swift c h cc cpp hpp cs php sh bash zsh fish ps1 sql graphql gql vue " +
    "svelte lua pl r scala dart diff patch srt vtt tex rst adoc org gradle tf hcl nix " +
    "dockerfile makefile gitignore editorconfig"
  ).split(" "),
);
const heifBrands = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "mif1",
  "msf1",
]);

function heifType(bytes) {
  if (bytes.length < 16 || bytes.toString("ascii", 4, 8) !== "ftyp") return null;
  const box = bytes.readUInt32BE(0);
  if (box < 16 || box > Math.min(bytes.length, 4096) || box % 4 !== 0) return null;
  for (let offset = 8; offset + 4 <= box; offset += 4)
    if (offset !== 12 && heifBrands.has(bytes.toString("ascii", offset, offset + 4)))
      return "image/heic";
  return null;
}

function textExtension(name) {
  const base = path.basename(String(name || "")).toLowerCase();
  const extension = base.includes(".") ? base.split(".").at(-1) : base;
  return textExtensions.has(extension) && base !== extension
    ? true
    : ["dockerfile", "makefile"].includes(base);
}

function plainText(bytes) {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The stored type of an upload, or null when it is not an accepted file. */
export function detectAttachment(bytes, name) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) return null;
  const raster = rasterType(bytes);
  if (raster && INLINE_IMAGE_TYPES.has(raster)) return { type: raster, kind: "image" };
  if (raster) return null;
  if (heifType(bytes)) return { type: "image/heic", kind: "image" };
  if (bytes.toString("latin1", 0, 5) === "%PDF-")
    return { type: "application/pdf", kind: "document" };
  if (textExtension(name) && plainText(bytes))
    return { type: "text/plain", kind: "text" };
  return null;
}

/** A display and storage name without directories, controls or reserved characters. */
export function safeFileName(name) {
  let base = typeof name === "string" ? name.split(/[/\\]/).at(-1) : "";
  base = base
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  if (!base) return "file";
  if (base.length <= 100) return base;
  const extension = path.extname(base).slice(0, 16);
  return base.slice(0, 100 - extension.length) + extension;
}

function size(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The lines appended to the owner's message so the agent knows where its copies are.
 * Paths are relative to the agent's own workspace. It is model input, in English
 * like the rest of AgentPier's agent-facing text; the chat strips it again.
 */
export function attachmentNote(files) {
  if (!files.length) return "";
  return [
    "[Attached files, saved in your workspace]",
    ...files.map((file) => `- ${file.path} (${file.type}, ${size(file.size)})`),
  ].join("\n");
}
