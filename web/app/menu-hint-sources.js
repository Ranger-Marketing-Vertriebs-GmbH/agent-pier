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
    // The first page of each listing, for the start page's pipelines card.
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
