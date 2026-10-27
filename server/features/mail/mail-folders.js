import { mailError } from "./mail-connection.js";

// Folders of a mailbox: the special-use folders (RFC 6154) and opening one for reading.

/**
 * The mailbox's special folders as paths, or null where it has none. The archive is
 * `\Archive`, else Gmail's `\All`, else a folder named Archive.
 */
export async function resolveFolders(client) {
  const folders = await client.list();
  // imapflow also guesses special use from folder names ("Archiv", "Sent Items");
  // a flag the server sets itself wins over such a guess.
  const flagged = (flag) =>
    folders.find((f) => f.specialUse === flag && f.specialUseSource !== "name")?.path;
  const use = (flag) =>
    flagged(flag) ?? folders.find((f) => f.specialUse === flag)?.path ?? null;
  const inbox =
    use("\\Inbox") ?? folders.find((f) => f.path.toUpperCase() === "INBOX")?.path ?? null;
  return {
    inbox,
    drafts: use("\\Drafts"),
    trash: use("\\Trash"),
    sent: use("\\Sent"),
    archive:
      flagged("\\Archive") ??
      flagged("\\All") ??
      use("\\Archive") ??
      folders.find((f) => f.path.toLowerCase() === "archive")?.path ??
      null,
  };
}

/**
 * Selects `path` read-only (EXAMINE), so nothing in it changes; a folder the server
 * does not have is MAIL_NOT_FOUND. Returns imapflow's mailbox state.
 */
export async function openFolder(client, path, { readOnly = true } = {}) {
  try {
    return await client.mailboxOpen(path, { readOnly });
  } catch (error) {
    if (error?.responseStatus === "NO") throw mailError("MAIL_NOT_FOUND");
    throw error;
  }
}
