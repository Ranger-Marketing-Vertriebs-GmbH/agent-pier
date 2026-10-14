import fs from "node:fs";
import path from "node:path";
import { packageCode } from "./package-errors.js";
import { toolchainManifest, toolchainTarget } from "./toolchain-manifest.js";
import {
  ensureToolchain,
  nodeDirectory,
  pythonDirectory,
  toolchainRoot,
} from "./toolchains.js";

const kinds = ["node", "python"];
const fallback = "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE";

/** Installer step: never fails the AgentPier installation; reports codes only. */
export async function provisionInstallerToolchains(
  { dataDir, platform, arch, glibc },
  { ensure = ensureToolchain } = {},
) {
  const result = {};
  try {
    // An unsupported target (musl, other platforms) must not create <data>/toolchains.
    toolchainTarget({ platform, arch, glibc });
  } catch (error) {
    const failed = { status: "failed", code: packageCode(error, fallback) };
    return { node: failed, python: { ...failed } };
  }
  for (const kind of kinds) {
    try {
      const toolchain = await ensure(kind, { dataDir, platform, arch, glibc });
      result[kind] = {
        status: "ready",
        version: toolchain.version ?? toolchain.pythonVersion,
      };
    } catch (error) {
      result[kind] = { status: "failed", code: packageCode(error, fallback) };
    }
  }
  return result;
}

/** Which kinds an update should prepare: an older one exists, the current not. */
export function toolchainStagingDue(
  dataDir,
  m = toolchainManifest,
  { platform, arch, glibc } = {},
) {
  const due = { node: false, python: false };
  let names;
  let target;
  try {
    names = fs.readdirSync(toolchainRoot(dataDir));
    target = toolchainTarget({ platform, arch, glibc });
  } catch {
    return due;
  }
  const current = {
    node: path.basename(nodeDirectory(dataDir, target, m)),
    python: path.basename(pythonDirectory(dataDir, target, m)),
  };
  for (const kind of kinds)
    due[kind] =
      !names.includes(current[kind]) &&
      names.some((name) => name.startsWith(`${kind}-`) && name.endsWith(`-${target}`));
  return due;
}

/** After an update: prepares new pins without blocking start; never rejects. */
export function stageToolchainsInBackground(
  { dataDir, platform, arch, glibc },
  { ensure = ensureToolchain } = {},
) {
  const due = toolchainStagingDue(dataDir, undefined, { platform, arch, glibc });
  const wanted = kinds.filter((kind) => due[kind]);
  if (!wanted.length) return Promise.resolve(null);
  return new Promise((resolve) => setImmediate(resolve)).then(async () => {
    for (const kind of wanted)
      try {
        await ensure(kind, { dataDir, platform, arch, glibc });
      } catch (error) {
        console.error(
          `AgentPier could not prepare the ${kind} toolchain: ${packageCode(error, fallback)}`,
        );
      }
    return { staged: wanted };
  });
}
