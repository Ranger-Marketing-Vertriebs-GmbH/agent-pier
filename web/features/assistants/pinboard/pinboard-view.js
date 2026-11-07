import { formatBytes } from "../../../lib/format-bytes.js";
import { videoDuration } from "../../../lib/format-duration.js";
import { locale as appLocale } from "../../../lib/i18n/index.js";

// What the pinboard shows of the view route's answer (`{ lists, fresh }`, newest list
// first; server/features/assistants/agent-pinboard-view.js). Pure, so lists, the
// reader's previous / next and the chat cards are tested without a browser.

const MAX_NAMES = 3;
const timeUnits = [
  ["year", 365 * 86400],
  ["month", 30 * 86400],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

/** Open lists in the server's order, archived ones apart (shown last, collapsed). */
export function pinboardSections(view) {
  const lists = view?.lists || [];
  return {
    open: lists.filter((list) => !list.archived),
    archived: lists.filter((list) => list.archived),
  };
}

/**
 * The entries around `entryId` that the reader steps to: the readable ones, and the
 * one being read even after it turned unavailable (the reader says so in its place),
 * so previous / next keep working. `entry` is that one; index -1 when it is gone.
 */
export function neighbours(list, entryId) {
  const entries = (list?.entries || []).filter(
    (entry) => entry.id === entryId || entry.state !== "unavailable",
  );
  const index = entries.findIndex((entry) => entry.id === entryId);
  return {
    entry: index >= 0 ? entries[index] : null,
    previous: index > 0 ? entries[index - 1] : null,
    next: index >= 0 && index < entries.length - 1 ? entries[index + 1] : null,
    index,
    total: entries.length,
  };
}

/** A row's sub line: "note · 2:41 · 48 MB", or that the file is gone. */
export function entryDetail(entry, copy, locale = appLocale) {
  if (entry.state === "unavailable") return copy.unavailable;
  return [
    entry.note,
    videoDuration(entry.duration),
    entry.size > 0 ? formatBytes(entry.size, locale) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "4 minutes ago", "yesterday"; "" for a time that does not parse. */
export function listTime(iso, now = Date.now(), locale = appLocale) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const seconds = Math.round((time - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of timeUnits)
    if (Math.abs(seconds) >= size) return format.format(Math.trunc(seconds / size), unit);
  return format.format(0, "second");
}

/**
 * The chat card's line for one list change: "2 files updated, 1 added · Episode 6,
 * Rough cut" (counts updated, added, removed; at most three names); empty parts are
 * left out with their separator.
 */
export function cardSummary(pinboard, copy) {
  const { counts } = copy.card;
  const parts = ["updated", "added", "removed"]
    .filter((kind) => pinboard?.[kind] > 0)
    .map((kind) => counts[kind](pinboard[kind]));
  const names = (pinboard?.names || []).slice(0, MAX_NAMES).join(copy.card.namesJoin);
  return [parts.join(", "), names].filter(Boolean).join(" · ");
}
