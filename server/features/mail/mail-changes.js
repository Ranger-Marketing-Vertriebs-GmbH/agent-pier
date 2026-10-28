import { randomUUID } from "node:crypto";
import { mailError } from "./mail-connection.js";
import { listedPath, resolveFolders } from "./mail-folders.js";
import { isAttachment, leafParts } from "./mail-messages.js";
import { composeMessage, replyHeaders } from "./mail-compose.js";
import {
  attachmentLimits,
  decodedRaw,
  fetchRawParts,
  messageParts,
  sha256,
} from "./mail-parts.js";
import { assistantProblem } from "../assistants/assistant-validation.js";

// Changing mail for agents: flags, moves, Trash and drafts. Nothing is ever deleted
// for good: no \Deleted flag, no EXPUNGE. A move needs the server's MOVE extension
// (RFC 6851), because imapflow would otherwise emulate it with COPY, \Deleted and
// EXPUNGE. Every folder is changed under imapflow's mailbox lock, released in finally.

const flagChanges = {
  read: ["add", "\\Seen"],
  unread: ["remove", "\\Seen"],
  flagged: ["add", "\\Flagged"],
  unflagged: ["remove", "\\Flagged"],
};

// The folders as the server lists them, the special ones, and the agent's folder
// resolved to its listed path (listedPath), else MAIL_NOT_FOUND.
async function mailboxOf(client, folder) {
  const listed = await client.list();
  const folders = await resolveFolders(client, listed);
  const resolve = (path) => {
    const found = listedPath(listed, path);
    if (!found) throw mailError("MAIL_NOT_FOUND");
    return found;
  };
  return { listed, folders, resolve, source: folder && resolve(folder) };
}

/** Runs `fn` with `path` selected read-write; a folder the server lacks is MAIL_NOT_FOUND. */
async function inFolder(client, path, fn, { readOnly = false } = {}) {
  let lock;
  try {
    lock = await client.getMailboxLock(path, { readOnly });
  } catch (error) {
    if (error?.responseStatus === "NO") throw mailError("MAIL_NOT_FOUND");
    throw error;
  }
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

// The UIDs of `uids` that exist in the selected folder; none is MAIL_NOT_FOUND.
async function existing(client, uids) {
  const found = await client.search({ uid: uids.join(",") }, { uid: true });
  if (!Array.isArray(found)) throw mailError("MAIL_PROTOCOL");
  const present = uids.filter((uid) => found.includes(uid));
  if (!present.length) throw mailError("MAIL_NOT_FOUND");
  return present;
}

function requireMove(client) {
  if (!client.capabilities.has("MOVE")) throw mailError("MAIL_MOVE_UNSUPPORTED");
}

async function move(client, uids, destination) {
  const result = await client.messageMove(uids.join(","), destination, { uid: true });
  if (!result) throw mailError("MAIL_PROTOCOL");
}

/** Sets or clears \Seen or \Flagged; returns how many of the messages exist. */
export async function markMessages(client, folder, uids, flag) {
  const [operation, name] = flagChanges[flag];
  const { source } = await mailboxOf(client, folder);
  return inFolder(client, source, async () => {
    const present = await existing(client, uids);
    const set = present.join(",");
    const done =
      operation === "add"
        ? await client.messageFlagsAdd(set, [name], { uid: true })
        : await client.messageFlagsRemove(set, [name], { uid: true });
    if (!done) throw mailError("MAIL_PROTOCOL");
    return { marked: present.length };
  });
}

/**
 * Moves messages to `destination`, a folder path or "archive" (the archive folder
 * of resolveFolders, else MAIL_NO_ARCHIVE). Returns the destination's path and how
 * many messages moved.
 */
export async function moveMessages(client, folder, uids, destination) {
  const { folders, resolve, source } = await mailboxOf(client, folder);
  let target;
  if (destination.toLowerCase() === "archive") {
    target = folders.archive;
    if (!target) throw mailError("MAIL_NO_ARCHIVE");
  } else target = resolve(destination);
  requireMove(client);
  return inFolder(client, source, async () => {
    const present = await existing(client, uids);
    if (source === target) return { destination: target, moved: 0 };
    await move(client, present, target);
    return {
      destination: target,
      moved: present.length,
      trash: target === folders.trash,
    };
  });
}

/**
 * Moves messages to the mailbox's Trash folder (never expunges). Messages already in
 * Trash stay there and count in `alreadyInTrash`; without Trash nothing changes
 * (MAIL_NO_TRASH).
 */
export async function trashMessages(client, folder, uids) {
  const { folders, source } = await mailboxOf(client, folder);
  const { trash } = folders;
  if (!trash) throw mailError("MAIL_NO_TRASH");
  const inTrash = source === trash;
  if (!inTrash) requireMove(client);
  return inFolder(client, source, async () => {
    const present = await existing(client, uids);
    if (inTrash) return { moved: 0, alreadyInTrash: present.length };
    await move(client, present, trash);
    return { moved: present.length, alreadyInTrash: 0 };
  });
}

// The parent's ids for In-Reply-To and References, read from the same account.
async function parentOf(client, folder, uid) {
  return inFolder(
    client,
    folder,
    async () => {
      const row = await client.fetchOne(
        String(uid),
        { uid: true, envelope: true, headers: ["references"] },
        { uid: true },
      );
      if (!row || row.uid !== uid) throw mailError("MAIL_NOT_FOUND");
      const references = String(row.headers ?? "")
        .replace(/\r?\n[ \t]+/g, " ")
        .match(/^references:(.*)$/im)?.[1];
      return {
        messageId: row.envelope?.messageId,
        inReplyTo: row.envelope?.inReplyTo,
        references,
      };
    },
    { readOnly: true },
  );
}

// The attachments of the draft to replace (selected) that the new one keeps, as raw
// parts: all but those named exactly in `removeNames`. A draft that is gone is
// MAIL_NOT_FOUND.
async function keptParts(client, uid, removeNames) {
  const parts = await messageParts(client, uid, { raw: true });
  return parts.filter((p) => !removeNames.includes(p.name));
}

// Over `mailBytes` of decoded attachments, or one file over `fileBytes`, is refused.
function checkSize(kept, rawParts, files) {
  const tooLarge = () => mailError("MAIL_ATTACHMENT_TOO_LARGE");
  if (files.some((file) => file.content.length > attachmentLimits.fileBytes))
    throw tooLarge();
  const total = [
    ...kept.map((p) => p.size),
    ...rawParts.map((raw) => decodedRaw(raw).length),
    ...files.map((file) => file.content.length),
  ].reduce((sum, size) => sum + size, 0);
  if (total > attachmentLimits.mailBytes) throw tooLarge();
}

// The stored draft's attachments and its HTML alternative, read back with digests.
async function readBack(client, uid) {
  const attachments = await messageParts(client, uid);
  const row = await client.fetchOne(
    String(uid),
    { uid: true, bodyStructure: true },
    { uid: true },
  );
  const html = leafParts(row?.bodyStructure).find(
    (n) => n.type === "text/html" && !isAttachment(n),
  );
  if (!html) return { attachments, htmlPart: null };
  const part = html.part || "1";
  const raw = (await fetchRawParts(client, uid, [part])).get(part);
  return { attachments, htmlPart: { part, partSha256: sha256(raw) } };
}

const isBug = (error) => error instanceof TypeError || error instanceof ReferenceError;

const domainOf = (address) => address.slice(address.lastIndexOf("@") + 1);

/**
 * Saves `fields` (draftFields) as a new draft in the Drafts folder, flagged \Draft
 * and \Seen, with its Bcc kept. A reply takes its thread headers from the parent
 * message. Attachments follow in this order: with `replaceUid` the old draft's
 * attachments not named exactly in `removeNames` (unchanged raw parts), then
 * `rawParts`, then `files` ({ filename, content, contentType }); `html` adds an HTML
 * alternative. More than `attachmentLimits.mailBytes` in all is
 * MAIL_ATTACHMENT_TOO_LARGE before anything is stored. With `replaceUid` the old
 * draft is moved to Trash after the new one is stored. Returns the new draft's UID,
 * Message-ID and thread headers (`thread`, what a send of it carries), its
 * attachments and HTML part as read back (`attachments`, `htmlPart`), and with
 * `replaceUid` whether the old draft went to Trash (`replaced`; false leaves both).
 * A stored draft that cannot be read back is returned with `unreadable: true`,
 * `attachments: null` and the old draft left in place. Attachments or HTML without
 * the new draft's UID are MAIL_PROTOCOL.
 */
export async function saveDraft(
  client,
  account,
  fields,
  { replaceUid, files = [], rawParts = [], html = null, removeNames = [] } = {},
) {
  if (removeNames.length && replaceUid === undefined) throw assistantProblem("invalid");
  const { folders, resolve } = await mailboxOf(client);
  if (!folders.drafts) throw mailError("MAIL_NO_DRAFTS");
  if (replaceUid !== undefined) {
    if (!folders.trash) throw mailError("MAIL_NO_TRASH");
    requireMove(client);
  }
  const thread =
    fields.replyToUid === undefined
      ? {}
      : replyHeaders(
          await parentOf(client, resolve(fields.replyToFolder), fields.replyToUid),
        );
  const messageId = `<${randomUUID()}@${domainOf(account.address)}>`;
  // Appending while Drafts is selected lets imapflow learn the UID without UIDPLUS.
  return inFolder(client, folders.drafts, async () => {
    const kept =
      replaceUid === undefined ? [] : await keptParts(client, replaceUid, removeNames);
    checkSize(kept, rawParts, files);
    const raw = await composeMessage(
      {
        from: { name: account.displayName || "", address: account.address },
        to: fields.to,
        cc: fields.cc,
        bcc: fields.bcc,
        subject: fields.subject,
        body: fields.body,
        messageId,
        ...thread,
        ...(html !== null && { html }),
        attachments: [
          ...kept.map((p) => ({ raw: p.raw })),
          ...rawParts.map((raw) => ({ raw })),
          ...files,
        ],
      },
      { keepBcc: true },
    );
    const appended = await client.append(folders.drafts, raw, ["\\Draft", "\\Seen"]);
    if (!appended) throw mailError("MAIL_PROTOCOL");
    const uid = appended.uid ?? null;
    // Without the new UID nothing can be read back, and a send could not prove what
    // it carries.
    const parts = kept.length || rawParts.length || files.length || html !== null;
    if (!uid && parts) throw mailError("MAIL_PROTOCOL");
    const stored = {
      folder: folders.drafts,
      draftUid: uid,
      messageId,
      thread: {
        inReplyTo: thread.inReplyTo ?? null,
        references: thread.references ?? [],
      },
    };
    let saved;
    try {
      saved = {
        ...stored,
        ...(uid ? await readBack(client, uid) : { attachments: [], htmlPart: null }),
      };
    } catch (error) {
      if (isBug(error)) throw error;
      // The new draft is stored but could not be read back: its UID is returned so it
      // is not saved twice, and the old draft stays.
      return {
        ...stored,
        attachments: null,
        htmlPart: null,
        unreadable: true,
        ...(replaceUid !== undefined && { replaced: false }),
      };
    }
    if (replaceUid === undefined) return saved;
    // The new draft is stored: a failed move of the old one must not hide it.
    try {
      await move(client, [replaceUid], folders.trash);
    } catch (error) {
      if (isBug(error)) throw error;
      return { ...saved, replaced: false };
    }
    return { ...saved, replaced: true };
  });
}

/**
 * After a send: appends the copy `raw` to the Sent folder when `saveSent`, flagged
 * \Seen, and moves the sent draft `draftUid` from Drafts to Trash. Each step is best
 * effort, because the mail is gone already: a step that fails leaves things as they
 * were and reports false.
 */
export async function fileSent(client, { raw, saveSent, draftUid }) {
  const { folders } = await mailboxOf(client);
  let savedToSent = false;
  let draftTrashed = false;
  if (saveSent && folders.sent)
    try {
      savedToSent = Boolean(await client.append(folders.sent, raw, ["\\Seen"]));
    } catch (error) {
      if (isBug(error)) throw error;
    }
  if (draftUid) draftTrashed = await draftToTrash(client, folders, draftUid);
  return { savedToSent, draftTrashed };
}

/**
 * Moves the draft `draftUid` from Drafts to Trash, best effort: false when it is gone,
 * a folder is missing, the server cannot move or the move failed.
 */
export async function trashDraft(client, draftUid) {
  const { folders } = await mailboxOf(client);
  return draftToTrash(client, folders, draftUid);
}

async function draftToTrash(client, folders, draftUid) {
  if (!folders.drafts || !folders.trash || !client.capabilities.has("MOVE")) return false;
  try {
    return await inFolder(client, folders.drafts, async () => {
      const found = await client.search({ uid: String(draftUid) }, { uid: true });
      if (!Array.isArray(found) || !found.includes(draftUid)) return false;
      await move(client, [draftUid], folders.trash);
      return true;
    });
  } catch (error) {
    if (isBug(error)) throw error;
    return false;
  }
}
