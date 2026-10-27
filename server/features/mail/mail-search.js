import { openFolder } from "./mail-folders.js";
import {
  attachmentsOf,
  fileName,
  fetchSummaries,
  summary,
  summaryQuery,
  uidSearch,
} from "./mail-messages.js";

// Mail search for agents. from, to, subject, text (headers and text), body (text
// only), since and unseen are one server-side UID SEARCH (non-ASCII terms go with
// CHARSET UTF-8; a server that refuses it is MAIL_SEARCH_UNSUPPORTED). Standard IMAP
// cannot search attachment names, so `attachment` and `hasAttachment` filter the
// BODYSTRUCTURE of the matches, newest first, over at most `scanLimit` candidates.

export const scanLimit = 500;
const scanBatch = 100;

const nonAscii = /[^\x00-\x7f]/;

/** The imapflow search query of the server-side criteria (empty: every message). */
export function serverCriteria(query) {
  const criteria = {};
  for (const key of ["from", "to", "subject", "text", "body"])
    if (query[key] !== undefined) criteria[key] = query[key];
  if (query.since !== undefined) criteria.since = new Date(`${query.since}T00:00:00Z`);
  if (query.unseen !== undefined) criteria.seen = !query.unseen;
  return criteria;
}

const folded = (value) => String(value).normalize("NFC").toLowerCase();

function attachmentFilter(query) {
  if (query.attachment === undefined && query.hasAttachment === undefined) return null;
  const needle = query.attachment === undefined ? null : folded(query.attachment);
  return (row) => {
    const attachments = attachmentsOf(row.bodyStructure);
    if (
      query.hasAttachment !== undefined &&
      attachments.length > 0 !== query.hasAttachment
    )
      return false;
    return (
      !needle || attachments.some((node) => folded(fileName(node) || "").includes(needle))
    );
  };
}

/**
 * The newest `limit` matches in `folder`. With an attachment criterion the result
 * also says how many candidates were `scanned` and whether the scan cap stopped it
 * (`partial`), so the agent can narrow the query.
 */
export async function searchMessages(client, folder, query, limit) {
  await openFolder(client, folder);
  const criteria = serverCriteria(query);
  const failure = Object.values(criteria).some((v) => nonAscii.test(String(v)))
    ? "MAIL_SEARCH_UNSUPPORTED"
    : "MAIL_PROTOCOL";
  const uids = await uidSearch(
    client,
    Object.keys(criteria).length ? criteria : { all: true },
    failure,
  );
  const filter = attachmentFilter(query);
  if (!filter) return { messages: await fetchSummaries(client, uids.slice(-limit)) };
  const newest = [...uids].reverse();
  const messages = [];
  let scanned = 0;
  while (scanned < newest.length && scanned < scanLimit && messages.length < limit) {
    const batch = newest.slice(
      scanned,
      scanned + Math.min(scanBatch, scanLimit - scanned),
    );
    const rows = await client.fetchAll(batch.join(","), summaryQuery, { uid: true });
    const byUid = new Map(rows.map((row) => [row.uid, row]));
    for (const uid of batch) {
      scanned++;
      const row = byUid.get(uid);
      if (row && filter(row)) messages.push(summary(row));
      if (messages.length >= limit) break;
    }
  }
  return {
    messages,
    scanned,
    partial: messages.length < limit && scanned < newest.length,
  };
}
