import { download as fetchDownload } from "../operations/releases.js";
import { packageProblem } from "./package-errors.js";

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
  fetchRegistryJson(`${registry}/${name.replace("/", "%2F")}`, { download });

export function npmVersions(packument) {
  const time = packument?.time || {};
  const versions = Object.entries(packument?.versions || {})
    .map(([version, info]) => ({
      version,
      publishedAt: typeof time[version] === "string" ? time[version] : null,
      prerelease: version.includes("-"),
      deprecated: !!info?.deprecated,
    }))
    .sort(
      (a, b) =>
        String(b.publishedAt).localeCompare(String(a.publishedAt)) ||
        b.version.localeCompare(a.version),
    );
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
