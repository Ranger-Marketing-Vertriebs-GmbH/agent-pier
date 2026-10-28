import { mailError } from "./mail-connection.js";
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
// BODYSTRUCTURE of the matches, newest first, over at most `scanLimit` candidates;
// `attachmentText` then reads the text of their attachments (mail-attachment-search.js).

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

// The newest messages of `newest` that pass `filter`, at most `max` of them, looking
// at no more than `scanLimit`; `positions` are their indexes in `newest`.
async function filterNewest(client, newest, filter, max) {
  const rows = [];
  const positions = [];
  let scanned = 0;
  while (scanned < newest.length && scanned < scanLimit && rows.length < max) {
    const batch = newest.slice(
      scanned,
      scanned + Math.min(scanBatch, scanLimit - scanned),
    );
    const fetched = await client.fetchAll(batch.join(","), summaryQuery, { uid: true });
    const byUid = new Map(fetched.map((row) => [row.uid, row]));
    for (const uid of batch) {
      const row = byUid.get(uid);
      if (row && filter(row)) {
        rows.push(row);
        positions.push(scanned);
      }
      scanned++;
      if (rows.length >= max) break;
    }
  }
  return { rows, positions, scanned };
}

// attachmentText: the other criteria (the name filters too) choose the candidates,
// `textScan` reads their attachments. `scanned` counts every message looked at.
async function searchText(client, folder, query, limit, newest, filter, textScan) {
  const uidValidity = String(client.mailbox?.uidValidity ?? "");
  const needle = query.attachmentText;
  if (!filter)
    return textScan(client, { folder, uidValidity, uids: newest, needle, limit });
  const named = await filterNewest(client, newest, filter, Infinity);
  const uids = named.rows.map((row) => row.uid);
  const result = await textScan(client, { folder, uidValidity, uids, needle, limit });
  if (result.scanned < uids.length)
    return {
      ...result,
      scanned: result.scanned && named.positions[result.scanned - 1] + 1,
    };
  const capped = named.scanned < newest.length && result.messages.length < limit;
  return {
    ...result,
    scanned: named.scanned,
    ...(capped && { partial: true, reason: result.reason ?? "candidates" }),
  };
}

/**
 * The newest `limit` matches in `folder`. With an attachment criterion the result
 * also says how many candidates were `scanned` and whether a cap stopped it
 * (`partial`, with a `reason` for the attachment text), so the agent can narrow the
 * query. `attachmentText` needs `textScan` (mail-attachment-search.js, bound to the
 * account and its text cache).
 */
export async function searchMessages(client, folder, query, limit, { textScan } = {}) {
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
  if (query.attachmentText !== undefined) {
    if (!textScan) throw mailError("MAIL_SEARCH_UNSUPPORTED");
    const newest = [...uids].reverse();
    return searchText(client, folder, query, limit, newest, filter, textScan);
  }
  if (!filter) return { messages: await fetchSummaries(client, uids.slice(-limit)) };
  const newest = [...uids].reverse();
  const { rows, scanned } = await filterNewest(client, newest, filter, limit);
  return {
    messages: rows.map(summary),
    scanned,
    partial: rows.length < limit && scanned < newest.length,
  };
}
