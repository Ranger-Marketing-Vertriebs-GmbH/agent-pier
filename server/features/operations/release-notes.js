import { releaseVersion } from "./release-archive.js";

export const officialChannel =
  "https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases/latest/download/";
const repository = "Ranger-Marketing-Vertriebs-GmbH/agent-pier";
const limit = 256 * 1024;

// Notes are optional presentation data, never part of update integrity or activation.
export class ReleaseNotes {
  constructor(fetchImpl) {
    this.fetch = fetchImpl;
    this.cache = new Map();
  }
  async read(channel, version) {
    releaseVersion(version);
    const unavailable = { version, body: null, url: null };
    if (`${channel.replace(/\/+$/, "")}/` !== officialChannel) return unavailable;
    const url = `https://github.com/${repository}/releases/tag/v${version}`;
    const key = version;
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.result;
    const result = this.load(version, url);
    // Bound storage and coalesce concurrent requests from multiple tabs.
    if (this.cache.size >= 20) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, { result, expires: Date.now() + 60000 });
    return result;
  }
  async load(version, url) {
    const fallback = { version, body: null, url };
    try {
      const response = await this.fetch(
        `https://api.github.com/repos/${repository}/releases/tags/v${version}`,
        {
          signal: AbortSignal.timeout(5000),
          redirect: "error",
          headers: { Accept: "application/vnd.github+json" },
        },
      );
      if (!response.ok || Number(response.headers.get("content-length")) > limit) {
        await response.body?.cancel();
        return fallback;
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > limit) return fallback;
        chunks.push(Buffer.from(chunk));
      }
      const release = JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
}
