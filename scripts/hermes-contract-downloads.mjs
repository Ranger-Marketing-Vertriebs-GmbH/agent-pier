import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isMainModule } from "../server/lib/is-main-module.js";
import { download as fetchDownload } from "../server/features/operations/releases.js";
import {
  hermesManifest,
  uvArchiveUrl,
  validHermesManifest,
} from "../server/features/assistants/runtimes/hermes/hermes-manifest.js";

/**
 * A download cache for the native Hermes contracts. GitHub rate-limits anonymous
 * downloads on shared CI runners (429, Retry-After 300), and the update contract
 * (tests/integration/hermes-update-contract.test.js) builds two pins from scratch.
 * The archives hermes-install.js downloads itself (uv, the Hermes source, the
 * agent-browser package, the PDFium wheel) are kept in the folder
 * AGENTPIER_HERMES_DOWNLOAD_CACHE names, one file per pinned SHA-256; everything
 * after the download (checksum, unpacking, `uv python install`, `uv sync`, the
 * identity check, the receipt) runs as without the cache. A file is used only while
 * its bytes still match the pin; a download is stored only when it matches.
 * CPython (`uv python install`) and the locked packages (`uv sync`) still come from
 * their upstreams: uv downloads them, outside AgentPier's download.
 */
export const hermesDownloadCacheVariable = "AGENTPIER_HERMES_DOWNLOAD_CACHE";

const previousManifestFile = new URL(
  "../tests/fixtures/hermes-previous-manifest.json",
  import.meta.url,
);
/** The previous pin the update contract updates from. */
export const previousHermesManifest = () =>
  validHermesManifest(JSON.parse(fs.readFileSync(previousManifestFile, "utf8")));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const defaultDownload = (url) => fetchDownload(url, fetch, 512 * 1024 * 1024);
const currentTarget = () => `${process.platform}-${process.arch}`;

/** The archives hermes-install.js downloads for `manifest` on `target`: url → SHA-256. */
export function hermesArchives(manifest, target) {
  const archives = new Map([
    [manifest.archiveUrl, manifest.archiveSha256],
    [manifest.agentBrowser.url, manifest.agentBrowser.sha256],
  ]);
  if (manifest.uvChecksums[target])
    archives.set(uvArchiveUrl(manifest, target), manifest.uvChecksums[target]);
  const wheel = manifest.pdfium?.wheels?.[target];
  if (wheel) archives.set(wheel.url, wheel.sha256);
  return archives;
}

/**
 * A `download` for hermes-install.js that serves the pinned archives of `manifests`
 * from `directory` and stores the ones it fetches; any other URL passes through.
 */
export function cachedHermesDownload(
  directory,
  {
    manifests = [hermesManifest, previousHermesManifest()],
    target = currentTarget(),
    download = defaultDownload,
  } = {},
) {
  const pinned = new Map(manifests.flatMap((m) => [...hermesArchives(m, target)]));
  return async (url) => {
    const expected = pinned.get(url);
    if (!expected) return download(url);
    const file = path.join(directory, expected);
    if (fs.existsSync(file)) {
      const bytes = fs.readFileSync(file);
      if (sha256(bytes) === expected) return bytes;
    }
    const bytes = await download(url);
    if (sha256(bytes) === expected) {
      fs.mkdirSync(directory, { recursive: true });
      const partial = `${file}.${randomUUID()}.partial`;
      fs.writeFileSync(partial, bytes);
      fs.renameSync(partial, file);
    }
    // hermes-install.js checks the checksum itself and fails on a mismatch.
    return bytes;
  };
}

/** The contracts' `download`: cached when AGENTPIER_HERMES_DOWNLOAD_CACHE is set. */
export function hermesContractDownload(environment = process.env) {
  const directory = environment[hermesDownloadCacheVariable];
  return directory ? cachedHermesDownload(path.resolve(directory)) : undefined;
}

/** Fetches every pinned archive of both pins into `directory` (CI, before the cache is saved). */
export async function prefetchHermesArchives(directory, options = {}) {
  const download = cachedHermesDownload(directory, options);
  const manifests = options.manifests || [hermesManifest, previousHermesManifest()];
  const target = options.target || currentTarget();
  for (const manifest of manifests)
    for (const [url, expected] of hermesArchives(manifest, target))
      if (sha256(await download(url)) !== expected)
        throw Error(`The archive ${url} does not match its pinned SHA-256.`);
}

/**
 * The prefetch's download: with `token` (CI passes the job's read-only GITHUB_TOKEN),
 * GitHub URLs are fetched authenticated, which lifts the anonymous rate limit; fetch
 * drops the header on the redirect to GitHub's download hosts. AgentPier's own
 * downloads (hermes-install.js) stay anonymous.
 */
export function prefetchDownload(
  token,
  { fetchImpl = fetch, fallback = defaultDownload } = {},
) {
  return async (url) => {
    const { host } = new URL(url);
    if (!token || !["github.com", "codeload.github.com"].includes(host))
      return fallback(url);
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw Error(`GitHub answered ${response.status} for ${url}.`);
    return Buffer.from(await response.arrayBuffer());
  };
}

if (isMainModule(import.meta.url)) {
  const [flag, directory] = process.argv.slice(2);
  if (flag !== "--prefetch" || !directory || !path.isAbsolute(directory))
    throw Error(
      "Usage: node scripts/hermes-contract-downloads.mjs --prefetch <absolute-directory>",
    );
  await prefetchHermesArchives(directory, {
    download: prefetchDownload(process.env.GITHUB_TOKEN),
  });
  process.stdout.write(`${fs.readdirSync(directory).length} Hermes archives cached.\n`);
}
