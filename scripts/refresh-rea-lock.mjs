import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../server/lib/is-main-module.js";
import { checkNpmLock } from "../server/features/mcp-packages/lock-check.js";
import { resolveNpm } from "../server/features/mcp-packages/npm-package-install.js";
import {
  npmPackument,
  npmRegistry,
  npmVersionInfo,
} from "../server/features/mcp-packages/registry-metadata.js";
import { ensureToolchain } from "../server/features/mcp-packages/toolchains.js";
import { reaManifest } from "../server/features/tools/rea-manifest.js";

const defaultOutput = fileURLToPath(
  new URL("../server/features/tools/rea-package-lock.json", import.meta.url),
);

// Maintainer operation only: resolves REA Core's npm graph into the committed
// lockfile with the managed Node toolchain, `--package-lock-only --ignore-scripts`,
// in a throwaway folder. Nothing is installed and no package script runs. Refuses
// unless the registry integrity equals `reaManifest.core.integrity`.
export async function refreshReaLock({
  dataDir,
  output = defaultOutput,
  manifest = reaManifest,
  registry = npmRegistry,
  download,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rea-lock-refresh-"));
  try {
    const ref = {
      registry: "npm",
      name: manifest.core.name,
      version: manifest.core.version,
    };
    const { integrity } = npmVersionInfo(
      await npmPackument(ref.name, { registry, download }),
      ref.version,
    );
    // The committed lock must belong to the tarball the manifest pins: refuse before
    // anything is resolved or written.
    if (integrity !== manifest.core.integrity)
      throw Error(
        `${ref.name}@${ref.version}: the registry integrity ${integrity} differs from ` +
          `reaManifest.core.integrity ${manifest.core.integrity}. Update the manifest first.`,
      );
    const node = await ensureToolchain("node", {
      dataDir: dataDir ?? path.join(root, "data"),
    });
    const { lockText } = await resolveNpm({
      stage: path.join(root, "stage"),
      ref,
      node,
      registry,
      cacheDir: path.join(root, "cache"),
    });
    const checked = checkNpmLock(lockText, { ref, integrity, registry });
    fs.writeFileSync(output, lockText);
    return {
      name: ref.name,
      version: ref.version,
      integrity,
      packages: checked.dependencies.length,
      needsScripts: checked.needsScripts,
      lockSha256: checked.digest,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (![0, 2].includes(args.length) || (args.length === 2 && args[0] !== "--data-dir"))
    throw Error("Usage: node scripts/refresh-rea-lock.mjs [--data-dir <absolute-dir>]");
  if (args[1] && !path.isAbsolute(args[1]))
    throw Error("The data directory must be absolute.");
  console.log(JSON.stringify(await refreshReaLock({ dataDir: args[1] }), null, 2));
}
