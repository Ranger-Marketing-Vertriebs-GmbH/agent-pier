import path from "node:path";
import { fold } from "./managed-folder.js";

// OpenClaw keeps media that reached a chat outside AgentPier's index of chat files: a
// channel's photo (and, before 2026.10.9, an image of AgentPier's chat) is staged in
// the workspace under media/inbound/openclaw-staged-<uuid>/, and a large image is
// offloaded to the Gateway's media store, shared by every agent, which the prompt
// names as media://inbound/<id>. Nothing records which chat such a file came from,
// so on an agent shared with users no turn names one (attachment-access.js asks with
// INBOUND_MEDIA, which no chat owns); the model still sees the image of its own turn,
// which OpenClaw loads itself, and its copy in attachments/ stays readable.

/** What a file tool call names in place of a file when it names inbound media. */
export const INBOUND_MEDIA = "media/inbound";
export const inboundRefusal =
  "Files in media/inbound/ and media:// references are not available to tools in this chat. Use the files sent in this chat by their attachments/ path.";
const inboundFolder = /(^|\/)media\/inbound(\/|$)/;

/**
 * Whether a path value names OpenClaw's inbound media: a media:// reference (also
 * behind the legacy "MEDIA:" prefix OpenClaw strips), or any path through a
 * media/inbound folder (the staged copies in the workspace, the store by its
 * absolute path), in any case.
 */
export function inboundMedia(value) {
  if (typeof value !== "string") return false;
  const source = value.trim().replace(/^MEDIA\s*:\s*(?!\/\/)/i, "");
  if (/^media:\/\//i.test(source)) return true;
  const normalized = path.posix.normalize(fold(source).replaceAll("\\", "/"));
  return inboundFolder.test(normalized);
}
