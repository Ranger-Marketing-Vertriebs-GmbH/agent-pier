import { extractableKind, extractText } from "./mail-extract.js";
import { attachmentLimits, decodedAtLeast, partBytes, partInfo } from "./mail-parts.js";
import { attachmentsOf, summary, summaryQuery } from "./mail-messages.js";
import { scanLimit } from "./mail-search.js";
import { byDeadline, deadlineTimer, late } from "./mail-shared.js";

// The attachment-text search: the text of PDF, Office, text and CSV attachments of
// the candidates, newest first, from the account's text cache or downloaded and
// extracted on demand. One search looks at most at `candidates` messages, until its
// deadline (the whole search call, a download and the wait for an extraction slot
// included) and with at most `bytes` fetched (each attachment's size counted before
// its download, then corrected to what came: a download given up on or refused as
// too large counts too), then ends with `partial` and the
// `reason`; what it extracted stays cached, so the next search continues faster. An
// extraction still waiting for a place when the search gives up is dropped from the
// queue with its bytes; one already running finishes and is cached. Only failures
// the document caused are cached. Neither text nor needle is logged.

export const searchBudget = Object.freeze({
  candidates: scanLimit,
  ms: 60_000,
  bytes: 209_715_200,
});
const fetchBatch = 100;

/** NFC, lower case, whitespace runs as one space and trimmed, for needle and text. */
export const foldText = (value) =>
  String(value).normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

const isMailError = (error) =>
  typeof error?.code === "string" && error.code.startsWith("MAIL_");

/**
 * The newest `limit` candidates with an attachment whose text contains `needle`,
 * each with `attachmentMatches: [{ part, name }]`, and how many were `scanned`. The
 * candidates are `uids` (newest first) or summary `rows` already fetched. `partial`
 * with `reason` "candidates", "time" or "bytes" when a budget stopped it; `partial`
 * with `skipped` when attachments were left out because extraction was busy or ran
 * out of time under load. `deadline` (ms, `now` clock) defaults to `budget.ms` away;
 * `generation` is the cache's for the account when the search began.
 */
export async function scanAttachmentText(
  client,
  {
    accountId,
    folder,
    uidValidity,
    uids,
    rows,
    needle,
    limit,
    cache = null,
    extract = extractText,
    budget = searchBudget,
    maxFileBytes = attachmentLimits.fileBytes,
    now = Date.now,
    wait = deadlineTimer,
    deadline = now() + budget.ms,
    generation = cache?.generation(accountId),
  },
) {
  const wanted = foldText(needle);
  if (!wanted) throw new RangeError("attachmentText needs a needle");
  const total = rows ? rows.length : uids.length;
  const messages = [];
  let scanned = 0;
  let fetched = 0;
  let skipped = 0;
  let reason;

  const keyOf = (uid, part) =>
    cache?.key({ accountId, folder, uidValidity, uid, part }) ?? null;
  // A write from before the account's text was dropped is dropped too.
  const remember = (key, value) => key && cache.set(accountId, key, value, generation);
  // Whether `promise` settles before the deadline: its value, or `late`.
  const inTime = (promise, label) => byDeadline(promise, deadline, { now, wait, label });

  async function download(uid, info) {
    const pending = partBytes(client, uid, info, { maxBytes: maxFileBytes });
    try {
      return await inTime(pending, "Mail attachment download failed:");
    } catch (error) {
      // Too large only for the limits of this call: never cached, so a higher limit
      // reads it again. Its bytes came all the same.
      if (error?.code === "MAIL_ATTACHMENT_TOO_LARGE")
        return { failed: error.code, fetched: Number(error.fetched) || 0 };
      if (error?.code === "MAIL_NOT_FOUND") return { failed: error.code, fetched: 0 };
      throw error;
    }
  }

  // The text of one attachment as { text } or { failed }, or { stop: reason } or
  // { skip: true }. Errors of the connection and programming errors end the search.
  async function textOf(uid, { info, wire }) {
    const key = keyOf(uid, info.part);
    const cached = key ? cache.get(accountId, key) : null;
    if (cached) return cached;
    if (now() >= deadline) return { stop: "time" };
    if (fetched + wire > budget.bytes) return { stop: "bytes" };
    // Counted before the download, so one given up on still counts.
    fetched += wire;
    const file = await download(uid, info);
    if (file === late) return { stop: "time" };
    fetched += file.fetched - wire;
    if (file.failed) return { failed: file.failed };
    // A folder that changed its UIDs meanwhile: the result belongs to no cache key.
    const storeKey = file.uidValidity === uidValidity ? key : null;
    let abandoned = false;
    // Aborted when the search gives up: a job still queued leaves the queue.
    const giveUp = new AbortController();
    const job = Promise.resolve()
      .then(() =>
        extract(file.bytes, extractableKind(info), {
          charset: info.charset,
          signal: giveUp.signal,
        }),
      )
      .then(
        (value) => ({ text: value.text, truncated: value.truncated === true }),
        (error) => {
          if (error?.document && isMailError(error)) return { failed: error.code };
          if (isMailError(error)) return { skip: true };
          return { bug: error };
        },
      );
    // An extraction still running at the deadline is cached when it ends.
    job
      .then((value) => {
        if (value.bug) {
          if (abandoned) console.error("Mail attachment text failed:", value.bug?.name);
        } else if (!value.skip) remember(storeKey, value);
      })
      .catch((error) => console.error("Mail attachment text failed:", error?.name));
    const outcome = await inTime(job);
    if (outcome === late) {
      abandoned = true;
      giveUp.abort();
      return { stop: "time" };
    }
    if (outcome.bug) throw outcome.bug;
    return outcome;
  }

  // One candidate: its matching attachments, or a stop before it counts as scanned.
  async function look(row) {
    const files = attachmentsOf(row.bodyStructure)
      .map((node) => ({ info: partInfo(node), wire: Number(node.size) || 0 }))
      .filter(
        ({ info }) => extractableKind(info) && decodedAtLeast(info) <= maxFileBytes,
      );
    const matches = [];
    let missed = false;
    for (const file of files) {
      const result = await textOf(row.uid, file);
      if (result.stop) return { stop: result.stop };
      if (result.skip) missed = true;
      else if (typeof result.text === "string" && foldText(result.text).includes(wanted))
        matches.push({ part: file.info.part, name: file.info.name });
    }
    return { matches, missed };
  }

  const count = Math.min(total, budget.candidates);
  outer: for (let at = 0; at < count; at += fetchBatch) {
    if (now() >= deadline) {
      reason = "time";
      break;
    }
    const end = Math.min(at + fetchBatch, count);
    const batch = rows
      ? rows.slice(at, end)
      : await inTime(
          client.fetchAll(uids.slice(at, end).join(","), summaryQuery, { uid: true }),
        );
    if (batch === late) {
      reason = "time";
      break;
    }
    const byUid = new Map(batch.map((row) => [row.uid, row]));
    for (const uid of rows ? batch.map((row) => row.uid) : uids.slice(at, end)) {
      const row = byUid.get(uid);
      if (row) {
        const found = await look(row);
        if (found.stop) {
          reason = found.stop;
          break outer;
        }
        if (found.missed) skipped++;
        if (found.matches.length)
          messages.push({ ...summary(row), attachmentMatches: found.matches });
      }
      scanned++;
      if (messages.length >= limit) break outer;
    }
  }
  if (!reason && messages.length < limit && scanned < total) reason = "candidates";
  return {
    messages,
    scanned,
    partial: Boolean(reason) || skipped > 0,
    ...(reason && { reason }),
    ...(skipped > 0 && { skipped }),
  };
}
