import { download as fetchDownload } from "../operations/releases.js";
import { packageProblem } from "./package-errors.js";
import { pypiVersionPattern } from "./package-spec.js";

export const npmRegistry = "https://registry.npmjs.org";
const metadataLimit = 64 * 1024 * 1024;
const defaultDownload = (url) =>
  fetchDownload(url, fetch, metadataLimit, { headers: { accept: "application/json" } });

export async function fetchRegistryJson(url, { download = defaultDownload } = {}) {
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

function newestFirst(a, b) {
  if (a.publishedAt !== b.publishedAt) {
    if (a.publishedAt === null) return 1;
    if (b.publishedAt === null) return -1;
    const byTime = b.publishedAt.localeCompare(a.publishedAt);
    if (byTime) return byTime;
  }
  return compareSemver(b.version, a.version) || b.version.localeCompare(a.version);
}

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
    .sort(newestFirst);
  return { latest: packument?.["dist-tags"]?.latest ?? null, versions };
}

const installHooks = ["preinstall", "install", "postinstall"];
export function npmVersionInfo(packument, version) {
  const info = packument?.versions?.[version];
  if (!info) throw packageProblem("MCP_PACKAGE_VERSION_NOT_FOUND", 404);
  return {
    integrity: info.dist?.integrity ?? null,
    bin: info.bin ?? null,
    installScripts: installHooks.some((hook) => typeof info.scripts?.[hook] === "string"),
  };
}

export const pypiRegistry = "https://pypi.org";
export const pypiProject = (name, { registry = pypiRegistry, download } = {}) =>
  fetchRegistryJson(`${registry}/pypi/${encodeURIComponent(name)}/json`, { download });
const pypiPrerelease = /(?:a|b|rc|\.dev)\d+/i;

export function pypiVersions(project) {
  const versions = Object.entries(project?.releases || {})
    .filter(
      ([version, files]) =>
        Array.isArray(files) && files.length && pypiVersionPattern.test(version),
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
    .sort(newestFirst);
  return { latest: project?.info?.version ?? null, versions };
}

export function pypiVersionInfo(project, version) {
  const files = project?.releases?.[version];
  if (!Array.isArray(files) || !files.length)
    throw packageProblem("MCP_PACKAGE_VERSION_NOT_FOUND", 404);
  return {
    files: files.map((f) => ({
      filename: f.filename,
      url: f.url,
      sha256: f.digests?.sha256,
      packagetype: f.packagetype,
    })),
    requiresPython: files.find((f) => f.requires_python)?.requires_python ?? null,
  };
}
