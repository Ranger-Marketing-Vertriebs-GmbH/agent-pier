import { historyText } from "./history-text.js";

// OpenClaw's history page cuts every message text at 8000 characters
// (history-text.js). A history page completes the messages it cut by reading each on
// its own with AgentPier's limit, bounded per page and shared between concurrent
// pages; a read that fails is retried later with a growing delay.
//
// States of a page message (the cache keeps them as they are):
// - complete: the whole text, no flag;
// - cut: read on its own and still incomplete (over AgentPier's limit, or OpenClaw's
//   "message too large" placeholder); without OpenClaw's marker, `cut: true`;
// - not yet read: the page's text with OpenClaw's marker. It is served without the
//   marker and with `partial: true` (`withoutMarks`), and a later page reads it.

// How many cut messages one history page reads on its own, and how many at once.
export const pageCompletions = 8;
const parallelReads = 4;
// Retry delays of a failed read: 5 s, doubling up to 5 min; at most this many ids kept.
const retryBase = 5000;
const retryMax = 300000;
const retryLimit = 1000;

const continues = (page, text) =>
  typeof text === "string" &&
  text.length > page.text.length &&
  text.startsWith(page.text);

/** The in-memory state of single reads: running ones and retry delays, per id. */
export function historyReads({ now = Date.now } = {}) {
  return { running: new Map(), retries: new Map(), now };
}

function retryLater(reads, key) {
  const failures = (reads.retries.get(key)?.failures || 0) + 1;
  reads.retries.delete(key);
  reads.retries.set(key, {
    failures,
    at: reads.now() + Math.min(retryBase * 2 ** (failures - 1), retryMax),
  });
  if (reads.retries.size > retryLimit)
    reads.retries.delete(reads.retries.keys().next().value);
}

// One single read per id at a time; concurrent pages share it. Resolves to the
// message's new state ({ text, cut }) or null when it stays unread.
function readOnce(reads, key, read, id, page) {
  const running = reads.running.get(key);
  if (running) return running;
  const job = (async () => {
    let text;
    try {
      text = await read(id);
    } catch {
      text = null;
    }
    // Only a text OpenClaw served decides; no answer (not ready, a swapped
    // runtime, an unknown id) leaves the message unread.
    const alone = typeof text === "string" ? historyText(text) : null;
    const state = !alone
      ? null
      : continues(page, alone.text)
        ? { text: alone.text, cut: alone.cut }
        : alone.cut
          ? { text: page.text, cut: true }
          : null;
    if (state) reads.retries.delete(key);
    else retryLater(reads, key);
    return state;
  })().finally(() => reads.running.delete(key));
  reads.running.set(key, job);
  return job;
}

/**
 * A history page's messages as complete as OpenClaw serves them, in the states
 * above. A message the page cut keeps an earlier state of the same id (`known`), or
 * is read on its own (`read(id)`: its text, or null), newest first, at most
 * `pageCompletions` per page and skipping ids whose retry is not yet due. `scope`
 * separates the ids of different conversations in `reads`.
 */
export async function completePage(
  messages,
  { known = new Map(), read, reads = historyReads(), scope = "" },
) {
  const pages = messages.map((m) => historyText(m.text));
  const result = messages.map((m, i) => {
    const page = pages[i];
    if (!page.cut) return m;
    const prior = known.get(m.id);
    const kept =
      typeof prior?.text === "string" &&
      !historyText(prior.text).cut &&
      (continues(page, prior.text) || (prior.cut === true && prior.text === page.text));
    return kept
      ? { ...m, text: prior.text, ...(prior.cut === true && { cut: true }) }
      : null;
  });
  const now = reads.now();
  const key = (i) => `${scope}\n${messages[i].id}`;
  const pending = result
    .map((m, i) => (m ? -1 : i))
    .filter((i) => i >= 0 && !(reads.retries.get(key(i))?.at > now))
    .reverse()
    .slice(0, pageCompletions);
  let next = 0;
  const work = async () => {
    while (next < pending.length) {
      const i = pending[next++];
      const state = await readOnce(reads, key(i), read, messages[i].id, pages[i]);
      if (state)
        result[i] = { ...messages[i], text: state.text, ...(state.cut && { cut: true }) };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(parallelReads, pending.length) }, work),
  );
  return result.map((m, i) => m ?? messages[i]);
}

/** Messages as served: a text still carrying OpenClaw's marks is `partial`. */
export function withoutMarks(messages) {
  return messages.map((m) => {
    if (typeof m.text !== "string") return m;
    const shown = historyText(m.text);
    return shown.cut ? { ...m, text: shown.text, partial: true } : m;
  });
}
