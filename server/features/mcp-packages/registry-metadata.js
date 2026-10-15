import { download as fetchDownload } from "../operations/releases.js";
import { packageProblem } from "./package-errors.js";
import { comparePep440 } from "./pep440.js";
import {
  canonicalPypiVersion,
  isPypiVersion,
  packageName,
  pypiVersionPattern,
} from "./package-spec.js";

export const npmRegistry = "https://registry.npmjs.org";
const metadataLimit = 64 * 1024 * 1024;
/** The default metadata download: JSON, size-capped, redirects only on the same origin. */
export const registryDownload = (url, fetchImpl = fetch) =>
  fetchDownload(url, fetchImpl, metadataLimit, {
    headers: { accept: "application/json" },
    pinOrigin: true,
  });

export async function fetchRegistryJson(url, { download = registryDownload } = {}) {
  let bytes;
  try {
    bytes = await download(url);
  } catch (error) {
    throw error?.status === 404
      ? packageProblem("MCP_PACKAGE_NOT_FOUND", 404)
      : packageProblem("MCP_PACKAGE_REGISTRY_UNAVAILABLE", 502);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw packageProblem("MCP_PACKAGE_REGISTRY_UNAVAILABLE", 502);
  }
}

export const npmPackument = (name, { registry = npmRegistry, download } = {}) =>
  fetchRegistryJson(`${registry}/${name.replaceAll("/", "%2F")}`, { download });

const isPrerelease = (version) => /-/.test(version.split("+")[0]);

function identifierCompare(a, b) {
  const numA = /^\d+$/.test(a);
  const numB = /^\d+$/.test(b);
  if (numA && numB) return Number(a) - Number(b);
  if (numA !== numB) return numA ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Ascending semver order; build metadata is ignored. */
export function compareSemver(a, b) {
  const [coreA, ...preA] = a.split("+")[0].split("-");
  const [coreB, ...preB] = b.split("+")[0].split("-");
  const partsA = coreA.split(".");
  const partsB = coreB.split(".");
  for (let index = 0; index < Math.max(partsA.length, partsB.length); index += 1) {
    const diff = identifierCompare(partsA[index] ?? "0", partsB[index] ?? "0");
    if (diff) return diff;
  }
  const tagA = preA.join("-");
  const tagB = preB.join("-");
  if (!tagA || !tagB) return (tagA ? -1 : 0) + (tagB ? 1 : 0);
  const idsA = tagA.split(".");
  const idsB = tagB.split(".");
  for (let index = 0; index < Math.min(idsA.length, idsB.length); index += 1) {
    const diff = identifierCompare(idsA[index], idsB[index]);
    if (diff) return diff;
  }
  return idsA.length - idsB.length;
}

const newestFirst = (compare) => (a, b) => {
  if (a.publishedAt !== b.publishedAt) {
    if (a.publishedAt === null) return 1;
    if (b.publishedAt === null) return -1;
    const byTime = b.publishedAt.localeCompare(a.publishedAt);
    if (byTime) return byTime;
  }
  return compare(b.version, a.version) || b.version.localeCompare(a.version);
};

export function npmVersions(packument) {
  const time = packument?.time || {};
  const versions = Object.entries(packument?.versions || {})
    .map(([version, info]) => ({
      version,
      publishedAt: typeof time[version] === "string" ? time[version] : null,
      prerelease: isPrerelease(version),
      deprecated: !!info?.deprecated,
      yanked: false,
    }))
    .sort(newestFirst(compareSemver));
  return { latest: packument?.["dist-tags"]?.latest ?? null, versions };
}

const installHooks = ["preinstall", "install", "postinstall"];
export function npmVersionInfo(packument, version) {
  const versions = packument?.versions;
  const info =
    versions && typeof versions === "object" && Object.hasOwn(versions, version)
      ? versions[version]
      : null;
  if (!info || typeof info !== "object")
    throw packageProblem("MCP_PACKAGE_VERSION_NOT_FOUND", 404);
  return {
    integrity: info.dist?.integrity ?? null,
    bin: info.bin ?? null,
    installScripts: installHooks.some((hook) => typeof info.scripts?.[hook] === "string"),
  };
}

export const pypiRegistry = "https://pypi.org";
export const pypiProject = (name, { registry = pypiRegistry, download } = {}) =>
  Promise.resolve().then(() =>
    fetchRegistryJson(
      `${registry}/pypi/${encodeURIComponent(packageName({ registry: "pypi", name }))}/json`,
      { download },
    ),
  );
const pypiPrerelease = /(?:a|b|rc|\.dev)\d+/i;

/**
 * PyPI marks the JSON API's `releases` key deprecated. Its absence must not read as
 * "no versions": it fails loudly so a change of the API is noticed (docs/mcp.md).
 */
function releasesOf(project) {
  const releases = project?.releases;
  if (releases && typeof releases === "object" && !Array.isArray(releases))
    return releases;
  console.error(
    "AgentPier could not read PyPI releases (the JSON API returned no releases key).",
  );
  throw packageProblem("MCP_PACKAGE_REGISTRY_UNAVAILABLE", 502);
}

export function pypiVersions(project) {
  const versions = Object.entries(releasesOf(project))
    .filter(
      ([version, files]) =>
        Array.isArray(files) && files.length && isPypiVersion(version),
    )
    .map(([version, files]) => ({
      version,
      publishedAt:
        files
          .map((f) => f.upload_time_iso_8601)
          .filter((at) => typeof at === "string")
          .sort()[0] ?? null,
      prerelease: pypiPrerelease.test(version),
      deprecated: false,
      yanked: files.every((f) => f.yanked === true),
    }))
    .sort(newestFirst(comparePep440));
  return { latest: project?.info?.version ?? null, versions };
}

/** The release under `version`, else under another spelling of the same version. */
function pypiRelease(project, version) {
  const releases = releasesOf(project);
  if (Object.hasOwn(releases, version)) return releases[version];
  const wanted = canonicalPypiVersion(version);
  const key = Object.keys(releases).find(
    (other) => pypiVersionPattern.test(other) && canonicalPypiVersion(other) === wanted,
  );
  return key === undefined ? null : releases[key];
}

export function pypiVersionInfo(project, version) {
  const files = pypiRelease(project, version);
  if (!Array.isArray(files) || !files.length)
    throw packageProblem("MCP_PACKAGE_VERSION_NOT_FOUND", 404);
  return {
    files: files.map((f) => ({
      filename: f.filename,
      url: f.url,
      sha256: f.digests?.sha256,
      packagetype: f.packagetype,
      yanked: f.yanked === true,
    })),
    requiresPython: files.find((f) => f.requires_python)?.requires_python ?? null,
  };
}
