import { mailError } from "../../mail/mail-connection.js";
import { saveDraft } from "../../mail/mail-changes.js";
import { forwardFields, loadOriginal } from "../../mail/mail-forward.js";
import { cardAttachments } from "./agent-mail-card.js";
import { newFileEntries } from "./agent-mail-draft-files.js";

// An agent's `forward` (agentpier_mail) up to its draft; from there it is a send
// (agent-mail-sends.js): the same level, recipient rules, hourly cap, card and
// delivery. The draft carries the original's attachments as raw parts, bound to the
// card by their digests like any other draft part, and its HTML part when it has one.

/** What the call's result says when the original's HTML part could not go along. */
export const htmlOmittedNote =
  "The original's HTML version is over 1 MiB, so only its text is forwarded.";

/**
 * The forward's draft, on one IMAP connection: the original (loadOriginal) within
 * the file count and bytes the `captured` files (captureFiles) leave, then saved with
 * its raw parts first, the files after them and the HTML alternative. Returns `{
 * saved, fields, html, original }`, saved as saveDraft returns it.
 */
export function saveForward(mail, account, from, request, captured) {
  const { limits } = mail;
  const read = captured?.read ?? [];
  const fileBytes = read.reduce((sum, r) => sum + r.bytes.length, 0);
  const { folder, uid, includeAttachments } = request.forward;
  return mail.w.s.mailAccounts.withImap(account.id, async (client) => {
    const original = await loadOriginal(client, folder, uid, {
      includeAttachments,
      maxBytes: limits.attachments.mailBytes - fileBytes,
      maxFiles: limits.attachments.files - read.length,
    });
    const { fields, html } = forwardFields(original, request.fields);
    const saved = await saveDraft(
      client,
      { address: account.address, displayName: from.name },
      fields,
      { rawParts: original.rawParts, files: captured?.entries ?? [], html },
    );
    return { saved, fields, html, original };
  });
}

/**
 * The card fields of a saved forward: `attachments` (the original's parts first,
 * source `original`, then the captured files with their sources, recorded as the
 * agent's like a send's), `html` (the draft's HTML part) and `forward` (the
 * original's sender, subject, date, folder and UID, and whether its HTML version goes
 * along or was omitted). A draft whose parts do not read
 * back as saved is MAIL_PROTOCOL.
 */
export function forwardCard(mail, accountId, agentId, request, result, captured) {
  const { saved, html, original } = result;
  const count = original.parts.length;
  const files = captured?.read.length ?? 0;
  if (
    !saved.attachments ||
    saved.attachments.length !== count + files ||
    saved.attachments
      .slice(0, count)
      .some((a, i) => a.sha256 !== original.parts[i].sha256)
  )
    throw mailError("MAIL_PROTOCOL");
  if (html !== null && !saved.htmlPart) throw mailError("MAIL_PROTOCOL");
  const entries = newFileEntries(saved.attachments, captured);
  mail.draftFiles.record(accountId, saved.messageId, agentId, entries);
  const { envelope } = original;
  return {
    attachments: cardAttachments(saved.attachments, (_p, i) =>
      i < count ? { kind: "original" } : entries[i - count]?.source,
    ),
    html: html === null ? null : saved.htmlPart,
    forward: {
      from: { name: envelope.from.name, address: envelope.from.address },
      subject: envelope.subject,
      date: envelope.date,
      folder: request.forward.folder,
      uid: request.forward.uid,
      // Whether the original's HTML version goes along, or was left out as too large.
      htmlIncluded: html !== null,
      htmlOmitted: original.htmlOmitted,
    },
  };
}
