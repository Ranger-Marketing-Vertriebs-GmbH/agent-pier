import path from "node:path";
import {
  INLINE_IMAGE_TYPES,
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_TOTAL_BYTES,
  attachmentNote,
  detectAttachment,
} from "./agent-attachment-types.js";
import { SHARED } from "./agent-share-store.js";
import { chatFolderPath } from "./chat-file-folders.js";

// What an agent learns of the owner's uploads (agent-attachments.js): the note its
// turn carries and the images its model sees inline, and the same notes again for
// the chat history, which strips them (attachment-history.js).

const FOLDER = "attachments";
const owned = `request_id NOT LIKE '${SHARED}%'`;
const publicFile = ({ id, name, type, kind, size, video }) => ({
  id,
  name,
  type,
  kind,
  size,
  ...(video && { video }),
});

/** The chat folder a row's copy lies in (chat-file-folders.js), or null. */
function chatFolder(a, file) {
  return file.chat
    ? chatFolderPath(a.config, file.row.assistant_id, file.row.conversation_id)
    : null;
}

/** The path a row's copy has for the agent: workspace-relative, or absolute. */
export function agentPath(a, file) {
  const folder = chatFolder(a, file);
  return folder ? path.join(folder, file.file) : `${FOLDER}/${file.file}`;
}

// The chat folder a request's files lie in, named in its note; null in attachments/.
const noteFolder = (a, files) => files.map((f) => chatFolder(a, f)).find(Boolean) ?? null;
const named = (a, files) => files.map((f) => ({ ...f, path: agentPath(a, f) }));

/**
 * The text the agent receives and the images its model sees inline; `byUser` when
 * the request is a restricted user's.
 */
export async function attachmentDelivery(
  a,
  request,
  assistantId,
  { byUser = false } = {},
) {
  const files = a.files(request.id);
  if (!files.length) return { message: request.text };
  const note = attachmentNote(named(a, files), { byUser, folder: noteFolder(a, files) });
  const message = request.text.trim() ? `${request.text}\n\n${note}` : note;
  const attachments = [];
  if (a.imageInput(assistantId) === false) return { message };
  let total = 0;
  for (const file of files) {
    if (!INLINE_IMAGE_TYPES.has(file.type)) continue;
    // The limits apply to the bytes actually read, and those must still be the
    // image that was uploaded.
    const body = await a.read(assistantId, file).catch(() => null);
    if (
      !body ||
      body.length > MAX_INLINE_IMAGE_BYTES ||
      total + body.length > MAX_INLINE_TOTAL_BYTES ||
      detectAttachment(body, file.name)?.type !== file.type
    )
      continue;
    total += body.length;
    attachments.push({
      type: "image",
      mimeType: file.type,
      fileName: file.name,
      content: body.toString("base64"),
    });
  }
  return attachments.length ? { message, attachments } : { message };
}

/** requestId → the public files and the note the agent received with them. */
export function conversationFiles(a, conversationId) {
  const byRequest = new Map();
  for (const file of a.rows(
    `SELECT * FROM agent_attachments WHERE conversation_id=? AND request_id IS NOT NULL AND ${owned} ORDER BY request_id, position`,
    conversationId,
  )) {
    const entry = byRequest.get(file.row.request_id) || { files: [] };
    entry.files.push(file);
    byRequest.set(file.row.request_id, entry);
  }
  // A user's chat names her as the sender; turns sent before it did still strip.
  let byUser = false;
  try {
    byUser = typeof a.store.storedConversation(conversationId)?.userId === "string";
  } catch {
    // An unknown chat has no files to name.
  }
  for (const entry of byRequest.values()) {
    const paths = named(a, entry.files);
    const folder = noteFolder(a, entry.files);
    entry.note = attachmentNote(paths, { byUser, folder });
    // A chat folder's turns sent before its files moved there named attachments/.
    const old = folder && entry.files.map((f) => ({ ...f, path: `${FOLDER}/${f.file}` }));
    const notes = [
      ...(byUser ? [attachmentNote(paths, { folder })] : []),
      ...(old ? [attachmentNote(old, { byUser }), attachmentNote(old)] : []),
    ];
    if (notes.length) entry.notes = [...new Set([entry.note, ...notes])];
    // A copy that is gone (deleted by the agent, or cleared by the owner) stays
    // in its message, named and marked unavailable, without a link.
    entry.files = entry.files.map((f) =>
      f.gone ? { ...publicFile(f), unavailable: true } : publicFile(f),
    );
  }
  return byRequest;
}
