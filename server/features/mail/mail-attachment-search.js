import { setTimeout as delay } from "node:timers/promises";
import { extractableKind, extractText } from "./mail-extract.js";
import {
  attachmentLimits,
  attachmentBytes,
  decodedAtLeast,
  partInfo,
} from "./mail-parts.js";
import { attachmentsOf, summary, summaryQuery } from "./mail-messages.js";
import { scanLimit } from "./mail-search.js";

// The attachment-text search: the text of PDF, Office, text and CSV attachments of
// the candidates, newest first, from the account's text cache or downloaded and
// extracted on demand. One search looks at most at `candidates` messages, for at
// most `ms` (waiting for an extraction slot included) and `bytes` downloaded, then
// ends with `partial` and the `reason`; what it extracted stays cached, so the next
// search continues faster. Neither the text nor the needle is ever logged.

export const searchBudget = Object.freeze({
  candidates: scanLimit,
  ms: 60_000,
  bytes: 209_715_200,
});
const fetchBatch = 100;
// Failures of the document itself: cached, so it is not tried again.
const documentFailures = new Set([
  "MAIL_TEXT_FAILED",
  "MAIL_TEXT_UNSUPPORTED",
  "MAIL_ATTACHMENT_TOO_LARGE",
]);

/** NFC, lower case and whitespace runs as one space, for needle and text alike. */
export const foldText = (value) =>
  String(value).normalize("NFC").toLowerCase().replace(/\s+/g, " ");

// Resolves after `ms`, or at once when `signal` aborts; never keeps the process up.
const timer = (ms, signal) =>
  delay(Math.max(0, ms), undefined, { signal, ref: false }).catch(() => {});

/**
 * The newest `limit` messages among `uids` (newest first) with an attachment whose
 * text contains `needle`, each with `attachmentMatches: [{ part, name }]`, and how
 * many candidates were `scanned`. `partial` with `reason` "candidates", "time" or
 * "bytes" when a budget stopped it; `partial` with `skipped` when attachments were
 * left out because every extraction slot was busy.
 */
export async function scanAttachmentText(
  client,
  {
    accountId,
    folder,
    uidValidity,
    uids,
    needle,
    limit,
    cache = null,
    extract = extractText,
    budget = searchBudget,
    maxFileBytes = attachmentLimits.fileBytes,
    now = Date.now,
    wait = timer,
  },
) {
  const deadline = now() + budget.ms;
  const wanted = foldText(needle);
  const messages = [];
  let scanned = 0;
  let downloaded = 0;
  let skipped = 0;
  let reason;

  const keyOf = (uid, part) =>
    cache?.key({ accountId, folder, uidValidity, uid, part }) ?? null;
  const remember = (key, value) => key && cache.set(accountId, key, value);

  // The text of one attachment as { text } or { failed }, or a stop: { stop: reason }
  // or { skip: true }. Errors of the connection end the whole search.
  async function textOf(uid, info) {
    const key = keyOf(uid, info.part);
    const cached = key ? cache.get(accountId, key) : null;
    if (cached) return cached;
    if (now() >= deadline) return { stop: "time" };
    if (downloaded + info.size > budget.bytes) return { stop: "bytes" };
    let file;
    try {
      file = await attachmentBytes(client, folder, uid, info.part, {
        maxBytes: maxFileBytes,
      });
    } catch (error) {
      if (documentFailures.has(error?.code)) {
        remember(key, { failed: error.code });
        return { failed: error.code };
      }
      if (error?.code === "MAIL_NOT_FOUND") return { failed: error.code };
      throw error;
    }
    downloaded += file.bytes.length;
    // A folder that changed its UIDs meanwhile: the result belongs to no cache key.
    const storeKey = file.uidValidity === String(uidValidity) ? key : null;
    const job = Promise.resolve()
      .then(() => extract(file.bytes, extractableKind(info), { charset: info.charset }))
      .then(
        (value) => ({ text: value.text, truncated: value.truncated === true }),
        (error) => (error?.busy ? { busy: true } : { failed: "MAIL_TEXT_FAILED" }),
      );
    // An extraction still running at the deadline is cached when it ends.
    job.then((value) => !value.busy && remember(storeKey, value));
    const stop = new AbortController();
    const late = wait(deadline - now(), stop.signal).then(() => null);
    const outcome = await Promise.race([job, late]);
    stop.abort();
    if (!outcome) return { stop: "time" };
    if (outcome.busy) return { skip: true };
    return outcome;
  }

  // One candidate: its matching attachments, or a stop before it counts as scanned.
  async function look(row) {
    const infos = attachmentsOf(row.bodyStructure)
      .map(partInfo)
      .filter((info) => extractableKind(info) && decodedAtLeast(info) <= maxFileBytes);
    const matches = [];
    let missed = false;
    for (const info of infos) {
      const result = await textOf(row.uid, info);
      if (result.stop) return { stop: result.stop };
      if (result.skip) missed = true;
      else if (typeof result.text === "string" && foldText(result.text).includes(wanted))
        matches.push({ part: info.part, name: info.name });
    }
    return { matches, missed };
  }

  const candidates = uids.slice(0, budget.candidates);
  outer: for (let at = 0; at < candidates.length; at += fetchBatch) {
    if (now() >= deadline) {
      reason = "time";
      break;
    }
    const batch = candidates.slice(at, at + fetchBatch);
    const rows = await client.fetchAll(batch.join(","), summaryQuery, { uid: true });
    const byUid = new Map(rows.map((row) => [row.uid, row]));
    for (const uid of batch) {
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
  if (!reason && messages.length < limit && scanned < uids.length) reason = "candidates";
  return {
    messages,
    scanned,
    partial: Boolean(reason) || skipped > 0,
    ...(reason && { reason }),
    ...(skipped > 0 && { skipped }),
  };
}
