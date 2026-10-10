import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isMainModule } from "../server/lib/is-main-module.js";
import { download as fetchDownload } from "../server/features/operations/releases.js";
import { runtimeManifest } from "../server/features/assistants/runtime-manifest.js";
import {
  dependencyLockDigest,
  readRuntimeLock,
  runtimeLockDirectory,
} from "../server/features/assistants/runtime-lock.js";

// Maintainer operation only. Product installation always consumes the reviewed lock.
// Dependabot excludes the lock; security fixes go through this refresh as described
// in docs/assistant-runtime-updates.md ("Refreshing the reviewed graph").
export async function refreshAssistantRuntimeLock({
  runtimeDirectory,
  outputDirectory = runtimeLockDirectory,
  manifest = runtimeManifest,
  download = (url) => fetchDownload(url, fetch, 256 * 1024 * 1024),
  execute = promisify(execFile),
}) {
  if (!path.isAbsolute(runtimeDirectory) || !path.isAbsolute(outputDirectory))
    throw Error("Absolute runtime and output directories are required.");
  const node = path.join(runtimeDirectory, "node/bin/node");
  const npm = path.join(runtimeDirectory, "node/lib/node_modules/npm/bin/npm-cli.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-lock-refresh-"));
  try {
    for (const name of ["home", "tmp", "cache"])
      fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    for (const name of ["user.npmrc", "global.npmrc"])
      fs.writeFileSync(path.join(root, name), "", { mode: 0o600 });
    const env = {
      HOME: path.join(root, "home"),
      TMPDIR: path.join(root, "tmp"),
      PATH: `${path.dirname(node)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      npm_config_userconfig: path.join(root, "user.npmrc"),
      npm_config_globalconfig: path.join(root, "global.npmrc"),
      npm_config_cache: path.join(root, "cache"),
      npm_config_update_notifier: "false",
    };
    const options = { cwd: root, env, timeout: 600000, maxBuffer: 2 * 1024 * 1024 };
    const nodeVersion = (await execute(node, ["--version"], options)).stdout.trim();
    const npmVersion = (await execute(node, [npm, "--version"], options)).stdout.trim();
    if (nodeVersion !== `v${manifest.nodeVersion}` || npmVersion !== manifest.npmVersion)
      throw Error("Lock authoring requires the manifest-pinned Node and npm.");
    const bytes = await download(manifest.packageUrl);
    if (createHash("sha512").update(bytes).digest("base64") !== manifest.packageIntegrity)
      throw Error("Assistant package integrity mismatch.");
    fs.writeFileSync(path.join(root, "openclaw.tgz"), bytes, { mode: 0o600 });
    const packageBytes = Buffer.from(
      JSON.stringify(
        {
          name: "agentpier-managed-assistants",
          version: "1.0.0",
          private: true,
          dependencies: { openclaw: "file:openclaw.tgz" },
        },
        null,
        2,
      ) + "\n",
    );
    fs.writeFileSync(path.join(root, "package.json"), packageBytes, { mode: 0o600 });
    await execute(
      node,
      [
        npm,
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--include=optional",
        "--no-audit",
        "--no-fund",
        "--registry=https://registry.npmjs.org",
      ],
      options,
    );
    const lockBytes = fs.readFileSync(path.join(root, "package-lock.json"));
    const digest = dependencyLockDigest(packageBytes, lockBytes);
    readRuntimeLock({ ...manifest, dependencyLockSha256: digest }, root);
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.writeFileSync(path.join(outputDirectory, "package.json"), packageBytes);
    fs.writeFileSync(path.join(outputDirectory, "package-lock.json"), lockBytes);
    return {
      version: manifest.version,
      nodeVersion: manifest.nodeVersion,
      npmVersion,
      dependencyLockSha256: digest,
      packageRecords: Object.keys(JSON.parse(lockBytes).packages).length,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (
    ![2, 4].includes(args.length) ||
    args[0] !== "--runtime" ||
    (args.length === 4 && args[2] !== "--output")
  )
    throw Error(
      "Usage: node scripts/refresh-assistant-runtime-lock.mjs --runtime <absolute-managed-runtime> [--output <absolute-lock-directory>]",
    );
  console.log(
    JSON.stringify(
      await refreshAssistantRuntimeLock({
        runtimeDirectory: args[1],
        ...(args[3] ? { outputDirectory: args[3] } : {}),
      }),
    ),
  );
}
