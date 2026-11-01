// What the menu hints and the start page are made of, from their live topics: the
// run counts, page 1 of three run statuses, the connection problems, the settings
// summary and the agent runtime's update status. Pure: Node tests import it.

/** The run lists the start page's pipelines card shows, by source key. */
export const MENU_HINT_RUN_TOPICS = Object.freeze({
  decisions: "pipeline.runs:*:awaiting-human",
  failed: "pipeline.runs:*:failed",
  running: "pipeline.runs:*:running",
});

const STATUS_OF = Object.freeze({
  decisions: "awaiting-human",
  failed: "failed",
  running: "running",
});

const countOf = (counts, status) => {
  const value = counts?.counts?.[status];
  return Number.isSafeInteger(value) ? value : null;
};
const runsOf = (listing) => (Array.isArray(listing?.runs) ? listing.runs : null);

// A part's value while it loads (undefined), once it failed (null) or answered.
const partOf = (part, value) =>
  !part || part.loading ? undefined : part.data == null ? null : value(part.data);

/**
 * What the start page's pipelines card and phone tile show, from the same `parts` as
 * menuHintSources, but each from its own sources only, so another source that is
 * slow or never answers keeps no skeleton in place (AGENTPIER-339): `lists`, page 1
 * of each status, and `counts` of running, decisions and failed. A value is undefined
 * while its topic loads, null when it failed, never a zero.
 */
export function startRunSources(parts) {
  const lists = {};
  for (const key of Object.keys(MENU_HINT_RUN_TOPICS))
    lists[key] = partOf(parts[key], runsOf);
  return {
    lists,
    counts: partOf(parts.counts, (counts) => ({
      decisions: countOf(counts, STATUS_OF.decisions),
      failed: countOf(counts, STATUS_OF.failed),
      running: countOf(counts, STATUS_OF.running),
    })),
  };
}

/**
 * The sources from the useLiveTopic results `parts` ({counts, decisions, failed,
 * running, problems, summary, updates}; a part that is not followed is null). Null
 * until every followed part has answered; a part that failed is null, never a zero.
 */
export function menuHintSources(parts) {
  if (Object.values(parts).some((part) => part?.loading)) return null;
  const data = (key) => parts[key]?.data ?? null;
  const counts = data("counts");
  return {
    decisions: countOf(counts, STATUS_OF.decisions),
    failed: countOf(counts, STATUS_OF.failed),
    running: countOf(counts, STATUS_OF.running),
    // The first page of each listing.
    runs: {
      decisions: runsOf(data("decisions")),
      failed: runsOf(data("failed")),
      running: runsOf(data("running")),
    },
    problems: data("problems"),
    summary: data("summary"),
    updates: data("updates"),
  };
}
