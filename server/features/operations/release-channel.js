import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { download } from "./release-download.js";
import { officialChannel } from "./release-notes.js";
import { repository } from "./release-notes-range.js";
import { compareReleaseVersions } from "./version.js";

export const isOfficialChannel = (channel) =>
  `${channel.replace(/\/+$/, "")}/` === officialChannel;

export function offeredVersion(version, channel) {
  return (
    typeof version === "string" &&
    version.length <= 80 &&
    (channel === "preview"
      ? /^\d+\.\d+\.\d+(?:-rc\.(?:0|[1-9]\d*))?$/.test(version)
      : /^\d+\.\d+\.\d+$/.test(version))
  );
}

export async function channelManifest(base, fetchImpl) {
  try {
    const manifest = JSON.parse(
      await download(new URL("latest.json", base).href, fetchImpl, 1024 * 1024, {
        retries: 1,
      }),
    );
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
      throw problem(serverMessages.releases.channelManifestInvalid);
    return manifest;
  } catch (error) {
    if (error.status === 404) throw problem(serverMessages.releases.notPublished, 404);
    if (error.status) throw error;
    throw problem(serverMessages.releases.channelManifestInvalid);
  }
}

export async function previewManifest(fetchImpl) {
  let version = null;
  // Read every page: creation order does not imply semantic version order.
  for (let page = 1; page <= 10; page++) {
    let entries;
    try {
      entries = JSON.parse(
        await download(
          `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
          fetchImpl,
          4 * 1024 * 1024,
          { retries: 1, headers: { Accept: "application/vnd.github+json" } },
        ),
      );
    } catch (error) {
      if (error.rateLimited)
        throw problem(serverMessages.releases.previewRateLimited, 503);
      if (error.status) throw error;
      throw problem(serverMessages.releases.channelManifestInvalid);
    }
    if (!Array.isArray(entries))
      throw problem(serverMessages.releases.channelManifestInvalid);
    for (const entry of entries) {
      const candidate =
        typeof entry?.tag_name === "string" && entry.tag_name.startsWith("v")
          ? entry.tag_name.slice(1)
          : null;
      if (
        entry?.draft !== false ||
        !offeredVersion(candidate, "preview") ||
        entry.prerelease !== candidate.includes("-") ||
        !Array.isArray(entry.assets) ||
        !entry.assets.some(
          (asset) => asset?.name === "latest.json" && asset.state === "uploaded",
        )
      )
        continue;
      if (!version || compareReleaseVersions(candidate, version) > 0) version = candidate;
    }
    if (entries.length < 100) {
      // A new stable release can appear between the API listing and this check.
      let stable;
      try {
        stable = await channelManifest(officialChannel, fetchImpl);
      } catch (error) {
        if (error.status !== 404 || !version) throw error;
      }
      if (stable && !offeredVersion(stable.version, "stable"))
        throw problem(serverMessages.releases.channelManifestInvalid);
      if (stable && (!version || compareReleaseVersions(stable.version, version) >= 0))
        return stable;
      const manifest = await channelManifest(
        new URL(`../../download/v${version}/`, officialChannel),
        fetchImpl,
      );
      if (manifest.version !== version)
        throw problem(serverMessages.releases.versionMismatch);
      return manifest;
    }
  }
  throw problem(serverMessages.releases.previewLimit, 503);
}
