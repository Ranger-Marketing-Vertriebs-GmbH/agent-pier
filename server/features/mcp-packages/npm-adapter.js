import { checkNpmLock } from "./lock-check.js";
import { installNpm, npmManifestText, resolveNpm } from "./npm-package-install.js";
import { packageProblem } from "./package-errors.js";
import { npmCommand } from "./package-store.js";
import { npmPrograms } from "./program-select.js";
import { npmPackument, npmVersionInfo, npmVersions } from "./registry-metadata.js";

/** The npm calls behind the registry adapter interface (mcp-packages.js). */
export const npmAdapter = {
  toolchainKind: "node",
  async versions(name, { registry, download }) {
    return npmVersions(await npmPackument(name, { registry, download }));
  },
  // Constraints are PyPI only (D4): the service refuses them for npm before this.
  async preview({
    ref,
    toolchain,
    stage,
    registry,
    download,
    cacheDir,
    execute,
    environment,
  }) {
    const info = npmVersionInfo(
      await npmPackument(ref.name, { registry, download }),
      ref.version,
    );
    const programs = npmPrograms(ref.name, info.bin);
    // Before the toolchain: a package without a program needs no Node.js download.
    if (!programs.length) throw packageProblem("MCP_PACKAGE_NO_PROGRAM", 400);
    const node = await toolchain();
    const resolved = await resolveNpm({
      stage,
      ref,
      node,
      registry,
      cacheDir,
      execute,
      environment,
    });
    const checked = checkNpmLock(resolved.lockText, {
      ref,
      integrity: info.integrity,
      registry,
    });
    return {
      integrity: info.integrity,
      programs,
      needsScripts: checked.needsScripts || info.installScripts,
      manifestText: resolved.manifestText,
      lockText: resolved.lockText,
      digest: checked.digest,
      dependencies: checked.dependencies,
    };
  },
  checkStored({ lockText, ref, integrity }, { registry }) {
    return checkNpmLock(lockText, { ref, integrity, registry });
  },
  manifestText: npmManifestText,
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
    return installNpm({
      directory,
      manifestText: preview.manifestText,
      lockText: preview.lockText,
      ref: preview.ref,
      node: toolchain,
      registry,
      cacheDir,
      allowScripts: preview.allowScripts,
      execute,
      environment,
      log,
    });
  },
  // npm names its programs in the packument, so the preview already chose one.
  programsAfterInstall: () => null,
  command: (dataDir, receipt, toolchain) => npmCommand(dataDir, receipt, toolchain),
  toolchainVersion: (toolchain) => toolchain.version,
};
