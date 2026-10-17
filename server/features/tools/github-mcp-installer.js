import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { problem } from "../../lib/storage.js";
import { githubMcpManifest, githubMcpPlatform } from "./github-mcp-manifest.js";

// The managed GitHub MCP server for agents (AGENTPIER-129): the pinned release archive,
// checked by its SHA-256, unpacked below <dataDir>/clis/.packages and activated
// through the <dataDir>/clis/github-mcp-server link, like the managed browser.
const record = "agentpier-github-mcp.json";
const packagePrefix = "github-mcp-";
const binary = "github-mcp-server";
const bad = (message) => problem(message, 409);
const allowedHosts = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

/** The activation link of the managed server. */
export const githubMcpActivation = (root) => path.join(root, binary);

/**
 * The installed managed server below `root` (<dataDir>/clis): its version and the
 * real path of its executable, or null. The real path names the version directory,
 * so an update changes what the Gateway compiles and is patched in.
 */
export function managedGithubMcp(root) {
  if (!root) return null;
  try {
    const directory = fs.realpathSync(githubMcpActivation(root));
    if (!directory.startsWith(fs.realpathSync(root) + path.sep)) return null;
    const info = JSON.parse(fs.readFileSync(path.join(directory, record), "utf8"));
    if (typeof info.version !== "string") return null;
    const executable = path.join(directory, binary);
    fs.accessSync(executable, fs.constants.X_OK);
    return { version: info.version, executable, directory };
  } catch {
    return null;
  }
}

function releaseURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw bad(serverMessages.tools.githubMcpDownloadFailed);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !allowedHosts.has(url.hostname) ||
    (url.hostname === "github.com" &&
      !url.pathname.startsWith("/github/github-mcp-server/releases/download/"))
  )
    throw bad(serverMessages.tools.forbiddenGithubRedirect);
  return url;
}

async function download(entry, fetchImpl, signal) {
  let url = releaseURL(entry.url);
  for (let redirects = 0; redirects <= 3; redirects++) {
    let response;
    try {
      response = await fetchImpl(url, {
        redirect: "manual",
        credentials: "omit",
        signal,
        headers: { Accept: "application/octet-stream", "User-Agent": "AgentPier" },
      });
    } catch {
      throw bad(serverMessages.tools.githubMcpDownloadFailed);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location || redirects === 3)
        throw bad(serverMessages.tools.invalidGithubRedirect);
      url = releaseURL(new URL(location, url).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw bad(serverMessages.tools.downloadHttpFailed(response.status));
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > entry.size) throw bad(serverMessages.tools.githubMcpChecksumMismatch);
        chunks.push(chunk);
      }
    } catch (error) {
      throw error.status ? error : bad(serverMessages.tools.githubMcpDownloadFailed);
    }
    const buffer = Buffer.concat(chunks);
    if (
      buffer.length !== entry.size ||
      createHash("sha256").update(buffer).digest("hex") !== entry.sha256
    )
      throw bad(serverMessages.tools.githubMcpChecksumMismatch);
    return buffer;
  }
  throw bad(serverMessages.tools.githubRedirectLimit);
}

/**
 * The server binary and its license from the checked release archive (gzip'd tar,
 * both regular files at the archive's root); anything else in it is ignored.
 */
export async function unpackGithubMcp(buffer) {
  let data;
  try {
    data = await promisify(gunzip)(buffer, { maxOutputLength: 256 * 1024 * 1024 });
  } catch {
    throw bad(serverMessages.tools.githubMcpArchiveInvalid);
  }
  const files = new Map();
  for (let offset = 0; offset + 512 <= data.length;) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, end) =>
      header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(field(124, 136).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || offset + 512 + size > data.length)
      throw bad(serverMessages.tools.githubMcpArchiveInvalid);
    const name = field(0, 100).replace(/^\.\//, "");
    const kind = String.fromCharCode(header[156]);
    if ([binary, "LICENSE"].includes(name)) {
      if ((kind !== "0" && kind !== "\0") || files.has(name))
        throw bad(serverMessages.tools.githubMcpArchiveInvalid);
      files.set(name, Buffer.from(data.subarray(offset + 512, offset + 512 + size)));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!files.get(binary)?.length || !files.get("LICENSE")?.length)
    throw bad(serverMessages.tools.githubMcpArchiveInvalid);
  return files;
}

/**
 * Removes version directories below `<root>/.packages` except `keep` and the one the
 * activation link points to now, read at prune time: a concurrent install (the server
 * and an installer script) that switched the link meanwhile keeps its version.
 */
export async function pruneGithubMcpPackages(root, keep) {
  const packages = path.join(root, ".packages");
  let active = null;
  try {
    active = await fsp.realpath(githubMcpActivation(root));
  } catch {
    /* No link: nothing extra to keep. */
  }
  const kept = new Set(
    [...keep, active].filter(Boolean).map((dir) => path.basename(dir)),
  );
  for (const name of await fsp.readdir(packages).catch(() => []))
    if (name.startsWith(packagePrefix) && !kept.has(name))
      await fsp.rm(path.join(packages, name), { recursive: true, force: true });
}

/**
 * Installs the pinned server, or replaces an installed one with it: download, check,
 * unpack into a fresh version directory, check `--version`, then swap the link
 * atomically (a running server keeps its old files until the Gateway is patched).
 */
export async function installGithubMcp({
  root,
  manifest = githubMcpManifest,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = fetch,
  signal = AbortSignal.timeout(10 * 60 * 1000),
  run,
  env = {},
}) {
  const entry = githubMcpPlatform(manifest, platform, arch);
  if (!entry) throw bad(serverMessages.tools.githubMcpPlatformUnavailable);
  const packages = path.join(root, ".packages");
  await fsp.mkdir(packages, { recursive: true, mode: 0o700 });
  const directory = path.join(packages, `${packagePrefix}${randomUUID()}`);
  let published = false;
  try {
    const files = await unpackGithubMcp(await download(entry, fetchImpl, signal));
    await fsp.mkdir(directory, { mode: 0o700 });
    await fsp.writeFile(path.join(directory, binary), files.get(binary), {
      mode: 0o700,
      flag: "wx",
    });
    await fsp.writeFile(path.join(directory, "LICENSE"), files.get("LICENSE"), {
      mode: 0o600,
      flag: "wx",
    });
    const output = await run(
      path.join(directory, binary),
      ["--version"],
      env,
      directory,
      signal,
      15000,
    );
    if (
      !new RegExp(`^Version: ${manifest.version.replaceAll(".", "\\.")}$`, "m").test(
        output,
      )
    )
      throw bad(serverMessages.tools.githubMcpVersionMismatch);
    await fsp.writeFile(
      path.join(directory, record),
      JSON.stringify({ version: manifest.version }),
      { mode: 0o600, flag: "wx" },
    );
    const previous = managedGithubMcp(root)?.directory;
    const link = path.join(root, `.github-mcp-link-${randomUUID()}`);
    await fsp.symlink(path.relative(root, directory), link, "dir");
    await fsp.rename(link, githubMcpActivation(root));
    published = true;
    // The previous version stays until the next update: a running server uses it.
    await pruneGithubMcpPackages(root, [directory, previous].filter(Boolean));
    return { version: manifest.version, executable: path.join(directory, binary) };
  } finally {
    if (!published)
      await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Installer step (setup.sh, release-install.mjs): brings an installed managed server
 * to the pinned version, so an update through the installer keeps it current. It
 * installs one only with `enable`; agents install it on first use otherwise (agent-
 * github.js). Never fails the AgentPier installation.
 */
export async function provisionGithubMcp(
  { dataDir, enable = false, platform = process.platform, arch = process.arch },
  { install = installGithubMcp, manifest = githubMcpManifest, fetchImpl = fetch } = {},
) {
  const root = path.join(dataDir, "clis");
  const installed = managedGithubMcp(root);
  if (!enable && !installed) return null;
  if (installed?.version === manifest.version)
    return { status: "ready", version: installed.version };
  if (!githubMcpPlatform(manifest, platform, arch))
    return {
      status: "unavailable",
      message: serverMessages.tools.githubMcpPlatformUnavailable,
    };
  try {
    // Loaded on use: the installer scripts run before AgentPier's dependencies exist.
    const [{ run }, { cleanEnvironment }] = await Promise.all([
      import("./tool-run.js"),
      import("../accounts/account-store.js"),
    ]);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const result = await install({
      root,
      manifest,
      platform,
      arch,
      fetchImpl,
      run,
      env: cleanEnvironment(),
    });
    return { status: "ready", version: result.version };
  } catch (error) {
    return { status: "failed", message: error.message };
  }
}
