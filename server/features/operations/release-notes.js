import { releaseVersion } from "./release-archive.js";
import {
  boundedJson,
  reachesActiveVersion,
  releaseListPage,
  releasePage,
  repository,
  selectReleaseRange,
} from "./release-notes-range.js";

export const officialChannel =
  "https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases/latest/download/";
const limit = 256 * 1024;
// A list page carries up to 100 release bodies; keep the total work bounded.
const pageLimit = 2 * 1024 * 1024;
const maxPages = 5;
const request = () => ({
  signal: AbortSignal.timeout(5000),
  redirect: "error",
  headers: { Accept: "application/vnd.github+json" },
});

// Bound storage and coalesce concurrent requests from multiple tabs.
function remember(cache, key, load) {
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.result;
  cache.delete(key);
  const result = load();
  if (cache.size >= 20) cache.delete(cache.keys().next().value);
  cache.set(key, { result, expires: Date.now() + 60000 });
  return result;
}
const official = (channel) => `${channel.replace(/\/+$/, "")}/` === officialChannel;

// Notes are optional presentation data, never part of update integrity or activation.
export class ReleaseNotes {
  constructor(fetchImpl) {
    this.fetch = fetchImpl;
    this.cache = new Map();
    this.rangeCache = new Map();
  }
  async read(channel, version) {
    releaseVersion(version);
    if (!official(channel)) return { version, body: null, url: null };
    return remember(this.cache, version, () => this.load(version, releasePage(version)));
  }
  async load(version, url) {
    const fallback = { version, body: null, url };
    try {
      const release = await boundedJson(
        await this.fetch(
          `https://api.github.com/repos/${repository}/releases/tags/v${version}`,
          request(),
        ),
        limit,
      );
      if (
        release.tag_name !== `v${version}` ||
        release.draft !== false ||
        typeof release.body !== "string" ||
        !release.body.trim()
      )
        return fallback;
      return { version, body: release.body, url };
    } catch {
      return fallback;
    }
  }
  async range(channel, from, to) {
    releaseVersion(from);
    releaseVersion(to);
    if (!official(channel))
      return {
        from,
        to,
        releases: [{ version: to, body: null, url: null }],
        truncated: false,
        url: null,
      };
    return remember(this.rangeCache, `${from}>${to}`, () =>
      this.loadRange(channel, from, to),
    );
  }
  async loadRange(channel, from, to) {
    const entries = [];
    let complete = false;
    try {
      for (let page = 1; page <= maxPages && !complete; page++) {
        const items = await boundedJson(
          await this.fetch(
            `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
            request(),
          ),
          pageLimit,
        );
        if (!Array.isArray(items)) throw new Error("Unexpected release list");
        entries.push(...items);
        complete = items.length < 100 || reachesActiveVersion(items, from);
      }
    } catch {
      // A partial list stays useful; the target is filled in below if it is missing.
    }
    const selected = selectReleaseRange(entries, from, to);
    const releases =
      selected.releases[0]?.version === to
        ? selected.releases
        : [await this.read(channel, to), ...selected.releases].slice(0, 20);
    return {
      from,
      to,
      releases,
      truncated: selected.truncated || (!complete && entries.length > 0),
      url: releaseListPage,
    };
  }
}
