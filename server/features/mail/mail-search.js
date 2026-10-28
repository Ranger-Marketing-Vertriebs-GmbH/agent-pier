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
// at no more than `scanLimit` and stopping at `deadline` (reason "time");
// `positions` are their indexes in `newest`.
async function filterNewest(client, newest, filter, max, { deadline, now } = {}) {
  const rows = [];
  const positions = [];
  let scanned = 0;
  let reason;
  while (scanned < newest.length && scanned < scanLimit && rows.length < max) {
    if (deadline !== undefined && now() >= deadline) {
      reason = "time";
      break;
    }
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
  return { rows, positions, scanned, reason };
}

// attachmentText: the other criteria (the name filters too) choose the candidates,
// `textScan` reads their attachments; the rows the name filter fetched are handed on.
// `scanned` counts every message looked at, the ones the name filter left out too.
async function searchText(client, folder, query, limit, newest, filter, scan) {
  const { textScan, deadline, now } = scan;
  const common = {
    folder,
    uidValidity: String(client.mailbox?.uidValidity ?? ""),
    needle: query.attachmentText,
    limit,
    ...(deadline !== undefined && { deadline }),
  };
  if (!filter) return textScan(client, { ...common, uids: newest });
  const named = await filterNewest(client, newest, filter, Infinity, { deadline, now });
  const result = await textScan(client, { ...common, rows: named.rows });
  const done = result.scanned >= named.rows.length;
  const scanned = done
    ? named.scanned
    : result.scanned && named.positions[result.scanned - 1] + 1;
  if (!done || result.messages.length >= limit || named.scanned >= newest.length)
    return { ...result, scanned };
  return {
    ...result,
    scanned,
    partial: true,
    reason: result.reason ?? named.reason ?? "candidates",
  };
}

/**
 * The newest `limit` matches in `folder`. With an attachment criterion the result
 * also says how many candidates were `scanned` and whether a cap stopped it
 * (`partial`, with a `reason` for the attachment text), so the agent can narrow the
 * query. `attachmentText` needs `textScan` (mail-attachment-search.js, bound to the
 * account and its text cache); its time limit `ms` counts from this call, so the
 * server search and the name filter use it up too.
 */
export async function searchMessages(
  client,
  folder,
  query,
  limit,
  { textScan, ms, now = Date.now } = {},
) {
  const deadline = ms === undefined ? undefined : now() + ms;
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
  const newest = [...uids].reverse();
  if (query.attachmentText !== undefined) {
    if (!textScan) throw mailError("MAIL_SEARCH_UNSUPPORTED");
    return searchText(client, folder, query, limit, newest, filter, {
      textScan,
      deadline,
      now,
    });
  }
  if (!filter) return { messages: await fetchSummaries(client, uids.slice(-limit)) };
  const { rows, scanned } = await filterNewest(client, newest, filter, limit);
  return {
    messages: rows.map(summary),
    scanned,
    partial: rows.length < limit && scanned < newest.length,
  };
}
