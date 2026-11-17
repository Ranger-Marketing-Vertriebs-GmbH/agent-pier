// The agent's memory wiki as the agentFiles sub-port answers it (agent-runtime.js
// wikiPages, wikiPage), from the memory-wiki plugin's Gateway methods (2026.11.3,
// scope operator.read): `wiki.overview`, its compiled dashboard (synthesis, entity
// and concept pages, and sources or reports that carry claims or questions; at most
// 2,500), and `wiki.get`, one page by its path or id. Only what the read page shows
// leaves here: a page's title, kind, time and Markdown, never the metadata naming the
// vault or a source's file (`sourcePath`, `provenanceLabel`).

// A page longer than this many lines is cut (`truncated`).
const maxLines = 4000;
const maxContent = 512 * 1024;
const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

const listed = (item) => ({
  lookup: text(item?.pagePath, 512),
  title: text(item?.title, 240),
  kind: text(item?.kind, 40),
  updatedAt: text(item?.updatedAt, 64),
});

/** The pages of `overview` (wiki.overview's answer), newest first. */
export function wikiListing(overview) {
  const pages = (Array.isArray(overview?.clusters) ? overview.clusters : [])
    .flatMap((cluster) => (Array.isArray(cluster?.items) ? cluster.items : []))
    .map(listed)
    .filter((page) => page.lookup)
    .sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title),
    );
  return {
    state: "ready",
    totalPages: Number.isSafeInteger(overview?.totalPages) ? overview.totalPages : 0,
    truncated: overview?.truncated === true,
    pages,
  };
}

// How long a rebuilding wiki asks to wait before the next read, bounded.
const retryBounds = [500, 10000];
const empty = { totalPages: 0, truncated: false, pages: [] };

/**
 * The listing a refusal of wiki.overview stands for, or null for a real failure:
 * `building` while OpenClaw rebuilds the compiled dashboard (UNAVAILABLE, details
 * state `rebuilding`, with its `retryAfterMs`, bounded), `empty` while a vault waits
 * for its first compile (INVALID_REQUEST, `compile-required`, which only the agent's
 * next wiki tool call ends).
 */
export function wikiRefusalListing(error) {
  if (error?.code === "UNAVAILABLE" && error.detailState === "rebuilding") {
    const wait = Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 1000;
    return {
      state: "building",
      retryAfterMs: Math.min(retryBounds[1], Math.max(retryBounds[0], wait)),
      ...empty,
    };
  }
  if (error?.code === "INVALID_REQUEST" && error.detailState === "compile-required")
    return { state: "empty", ...empty };
  return null;
}

/**
 * `error` as the port names a Gateway that has not loaded the plugin (unknown
 * method: normal after the first wiki until the queued restart ran): code
 * WIKI_NOT_LOADED. Any other error as it is.
 */
export function wikiError(error) {
  if (
    error?.code === "INVALID_REQUEST" &&
    /^unknown method: wiki\./.test(error.remoteMessage || "")
  )
    return Object.assign(new Error("The memory wiki is not loaded yet."), {
      code: "WIKI_NOT_LOADED",
      status: 503,
    });
  return error;
}

/** One page of wiki.get's answer, or null for none. */
export function wikiPageOf(answer) {
  if (!answer || typeof answer !== "object" || typeof answer.content !== "string")
    return null;
  const content = answer.content.slice(0, maxContent);
  return {
    ...listed({ ...answer, pagePath: answer.path }),
    content,
    truncated: answer.truncated === true || content.length < answer.content.length,
  };
}

/** wiki.get's parameters for one whole page (up to maxLines). */
export const wikiGetParams = (agentId, lookup) => ({
  agentId,
  lookup,
  fromLine: 1,
  lineCount: maxLines,
});
