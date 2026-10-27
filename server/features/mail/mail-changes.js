import { randomUUID } from "node:crypto";
import { mailError } from "./mail-connection.js";
import { resolveFolders } from "./mail-folders.js";
import { attachmentsOf } from "./mail-messages.js";
import { composeMessage, replyHeaders } from "./mail-compose.js";

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

const samePath = (a, b) =>
  a === b || (a.toUpperCase() === "INBOX" && b.toUpperCase() === "INBOX");

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
  return inFolder(client, folder, async () => {
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
  const folders = await resolveFolders(client);
  let target = destination;
  if (destination.toLowerCase() === "archive") {
    target = folders.archive;
    if (!target) throw mailError("MAIL_NO_ARCHIVE");
  } else {
    const list = await client.list();
    target = list.find((f) => samePath(f.path, destination))?.path;
    if (!target) throw mailError("MAIL_NOT_FOUND");
  }
  requireMove(client);
  return inFolder(client, folder, async () => {
    const present = await existing(client, uids);
    if (samePath(folder, target)) return { destination: target, moved: 0 };
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
  const { trash } = await resolveFolders(client);
  if (!trash) throw mailError("MAIL_NO_TRASH");
  const inTrash = samePath(folder, trash);
  if (!inTrash) requireMove(client);
  return inFolder(client, folder, async () => {
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

// The draft to replace exists and carries no attachment AgentPier cannot rebuild.
async function checkReplaced(client, uid) {
  const row = await client.fetchOne(
    String(uid),
    { uid: true, bodyStructure: true },
    { uid: true },
  );
  if (!row || row.uid !== uid) throw mailError("MAIL_NOT_FOUND");
  if (attachmentsOf(row.bodyStructure).length)
    throw mailError("MAIL_ATTACHMENTS_UNSUPPORTED");
}

const domainOf = (address) => address.slice(address.lastIndexOf("@") + 1);

/**
 * Saves `fields` (draftFields) as a new draft in the Drafts folder, flagged \Draft
 * and \Seen, with its Bcc kept. A reply takes its thread headers from the parent
 * message. With `replaceUid` the old draft is checked first and moved to Trash after
 * the new one is stored. Returns the new draft's UID and Message-ID.
 */
export async function saveDraft(client, account, fields, { replaceUid } = {}) {
  const folders = await resolveFolders(client);
  if (!folders.drafts) throw mailError("MAIL_NO_DRAFTS");
  if (replaceUid !== undefined) {
    if (!folders.trash) throw mailError("MAIL_NO_TRASH");
    requireMove(client);
  }
  const thread =
    fields.replyToUid === undefined
      ? {}
      : replyHeaders(await parentOf(client, fields.replyToFolder, fields.replyToUid));
  const messageId = `<${randomUUID()}@${domainOf(account.address)}>`;
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
    },
    { keepBcc: true },
  );
  // Appending while Drafts is selected lets imapflow learn the UID without UIDPLUS.
  return inFolder(client, folders.drafts, async () => {
    if (replaceUid !== undefined) await checkReplaced(client, replaceUid);
    const appended = await client.append(folders.drafts, raw, ["\\Draft", "\\Seen"]);
    if (!appended) throw mailError("MAIL_PROTOCOL");
    if (replaceUid !== undefined) await move(client, [replaceUid], folders.trash);
    return { folder: folders.drafts, draftUid: appended.uid ?? null, messageId };
  });
}
