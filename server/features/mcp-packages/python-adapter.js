import fs from "node:fs";
import path from "node:path";
import { download as fetchDownload } from "../operations/releases.js";
import { packageError, packageProblem } from "./package-errors.js";
import { normalizePypiName } from "./package-spec.js";
import { pythonCommand } from "./package-store.js";
import { installPython, resolvePython } from "./python-package-install.js";
import { checkPythonLock } from "./python-lock-check.js";
import { pypiProject, pypiVersionInfo, pypiVersions } from "./registry-metadata.js";
import { sha256Matches } from "./verified-files.js";
import {
  consoleScripts,
  installedEntryPoints,
  wheelEntryPoints,
} from "./wheel-programs.js";

/** The JSON API and the simple index AgentPier resolves PyPI packages from. */
export const pypiIndexRegistry = Object.freeze({
  api: "https://pypi.org",
  index: "https://pypi.org/simple",
});
const fileHost = "https://files.pythonhosted.org/";
const wheelLimit = 128 * 1024 * 1024;
const sha256 = /^[0-9a-f]{64}$/;
const mismatch = () => packageProblem("MCP_PACKAGE_INTEGRITY_MISMATCH", 502);
const manifestText = (ref) => `${ref.name}==${ref.version}\n`;

/**
 * The release files PyPI vouches for: a sha256 digest, not yanked, served from
 * files.pythonhosted.org. Only a test index injected in place of pypi.org may serve
 * its files from its own host.
 */
function trustedFiles(info, registry) {
  const official = registry.api === pypiIndexRegistry.api;
  return info.files
    .map((file) => ({ ...file, sha256: String(file.sha256 ?? "").toLowerCase() }))
    .filter(
      (file) =>
        file.yanked !== true &&
        sha256.test(file.sha256) &&
        typeof file.url === "string" &&
        (!official || file.url.startsWith(fileHost)),
    );
}

/** The digests stored as the package's integrity: `sha256:<hex>`, sorted, space-separated. */
const integrityOf = (digests) =>
  [...new Set(digests)]
    .sort()
    .map((digest) => `sha256:${digest}`)
    .join(" ");
function digestsOf(integrity) {
  const parts = typeof integrity === "string" && integrity ? integrity.split(" ") : [];
  const digests = parts.map((part) => /^sha256:([0-9a-f]{64})$/.exec(part)?.[1]);
  if (!digests.length || digests.some((digest) => !digest)) throw mismatch();
  return digests;
}

/** The top release's wheel (a pure one first), checked against its PyPI digest. */
async function topWheel(files, download) {
  const wheels = files.filter((file) => file.packagetype === "bdist_wheel");
  const wheel =
    wheels.find((file) => file.filename?.endsWith("-py3-none-any.whl")) || wheels[0];
  if (!wheel) return null;
  let bytes;
  try {
    bytes = await (download || ((url) => fetchDownload(url, fetch, wheelLimit)))(
      wheel.url,
    );
  } catch {
    throw packageProblem("MCP_PACKAGE_DOWNLOAD_FAILED", 502);
  }
  if (!Buffer.isBuffer(bytes) || !sha256Matches(bytes, wheel.sha256)) throw mismatch();
  return bytes;
}

/** Console scripts of the wheel; the reader's errors name stage paths, never shown. */
async function wheelPrograms({ bytes, stage, python, execute }) {
  try {
    const wheelFile = path.join(stage, "top.whl");
    fs.writeFileSync(wheelFile, bytes, { mode: 0o600 });
    return consoleScripts(await wheelEntryPoints({ python, wheelFile, execute }));
  } catch (error) {
    throw packageError(error, "MCP_PACKAGE_INSTALL_FAILED", 502);
  }
}

/** PyPI behind the registry adapter interface (mcp-packages.js). */
export const pythonAdapter = {
  toolchainKind: "python",
  async versions(name, { registry, download }) {
    return pypiVersions(await pypiProject(name, { registry: registry.api, download }));
  },
  /**
   * Programs come from the top wheel's entry_points.txt. A release without a wheel
   * (sdist only) names its programs only after its build (programsAfterInstall).
   */
  async preview({
    ref,
    allowScripts,
    constraints = [],
    toolchain,
    stage,
    registry,
    download,
    cacheDir,
    execute,
    environment,
  }) {
    const info = pypiVersionInfo(
      await pypiProject(ref.name, { registry: registry.api, download }),
      ref.version,
    );
    const files = trustedFiles(info, registry);
    if (!files.length) throw packageProblem("MCP_PACKAGE_FOREIGN_SOURCE", 400);
    const digests = files.map((file) => file.sha256);
    const bytes = await topWheel(files, download);
    const python = await toolchain();
    let programs = [];
    if (bytes) {
      programs = await wheelPrograms({ bytes, stage, python, execute });
      if (!programs.length) throw packageProblem("MCP_PACKAGE_NO_PROGRAM", 400);
    }
    const resolved = await resolvePython({
      stage,
      ref,
      python,
      index: registry.index,
      cacheDir,
      allowScripts,
      constraints,
      execute,
      environment,
    });
    const checked =
      resolved.lockText === null
        ? { digest: null, dependencies: [] }
        : checkPythonLock(resolved.lockText, { ref, digests });
    return {
      integrity: integrityOf(digests),
      programs,
      needsScripts: resolved.needsScripts,
      manifestText: resolved.requirementsText,
      lockText: resolved.lockText,
      digest: checked.digest,
      dependencies: checked.dependencies,
    };
  },
  /** The exact stored text, against the PyPI digests the preview pinned. */
  checkStored({ lockText, ref, integrity }) {
    return checkPythonLock(lockText, { ref, digests: digestsOf(integrity) });
  },
  manifestText,
  install({
    directory,
    preview,
    toolchain,
    registry,
    cacheDir,
    execute,
    environment,
    log,
  }) {
    return installPython({
      directory,
      requirementsText: preview.manifestText,
      lockText: preview.lockText,
      python: toolchain,
      index: registry.index,
      cacheDir,
      // Builds only what has no wheel, and only with the owner's opt-in.
      allowScripts: preview.allowScripts === true && preview.needsScripts === true,
      execute,
      environment,
      log,
    });
  },
  programsAfterInstall(directory, ref) {
    try {
      const venv = path.join(directory, "venv");
      return consoleScripts(installedEntryPoints(venv, normalizePypiName(ref.name)));
    } catch (error) {
      throw packageError(error, "MCP_PACKAGE_NO_PROGRAM", 502);
    }
  },
  command: (dataDir, receipt) => pythonCommand(dataDir, receipt),
  toolchainVersion: (toolchain) => `${toolchain.pythonVersion}+uv${toolchain.uvVersion}`,
};
