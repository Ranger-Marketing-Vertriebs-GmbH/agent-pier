import { releaseVersion } from "./release-archive.js";
import { compareReleaseVersions } from "./version.js";

export const repository = "Ranger-Marketing-Vertriebs-GmbH/agent-pier";
export const releasePage = (version) =>
  `https://github.com/${repository}/releases/tag/v${version}`;
export const releaseListPage = `https://github.com/${repository}/releases`;
export const RANGE_LIMIT = 20;

function published(entry, target) {
  if (!entry || typeof entry !== "object" || entry.draft !== false) return null;
  const version =
    typeof entry.tag_name === "string" && entry.tag_name.startsWith("v")
      ? entry.tag_name.slice(1)
      : "";
  try {
    releaseVersion(version);
  } catch {
    return null;
  }
  // The target is shown even when it is a prerelease the user chose to install.
  if (entry.prerelease !== false && version !== target) return null;
  return version;
}

// GitHub lists releases by creation time; any listed version at or below the active one
// means the remaining pages only hold older releases.
export function reachesActiveVersion(entries, from) {
  return entries.some((entry) => {
    const version = published(entry, null);
    return version !== null && compareReleaseVersions(version, from) <= 0;
  });
}

export function selectReleaseRange(entries, from, to, limit = RANGE_LIMIT) {
  const versions = new Map();
  for (const entry of entries) {
    const version = published(entry, to);
    if (
      version === null ||
      versions.has(version) ||
      compareReleaseVersions(version, from) <= 0 ||
      compareReleaseVersions(version, to) > 0
    )
      continue;
    const date = new Date(entry.published_at);
    versions.set(version, {
      version,
      body: typeof entry.body === "string" && entry.body.trim() ? entry.body : null,
      url: releasePage(version),
      publishedAt:
        typeof entry.published_at === "string" && !Number.isNaN(date.getTime())
          ? date.toISOString()
          : null,
    });
  }
  const releases = [...versions.values()].sort((a, b) =>
    compareReleaseVersions(b.version, a.version),
  );
  return { releases: releases.slice(0, limit), truncated: releases.length > limit };
}

// Reads a bounded JSON body; throws on any size violation or malformed content.
export async function boundedJson(response, limit) {
  if (!response.ok || Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("Release notes unavailable");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("Release notes too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
