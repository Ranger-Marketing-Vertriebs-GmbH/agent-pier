import fs from "node:fs";
import path from "node:path";
import { chromiumManifest } from "./chromium-manifest.js";
import {
  chromiumUnavailable,
  installChromium,
  managedChromium,
} from "./chromium-installer.js";

/**
 * Installer step for `--with-agent-browser` (setup.sh, release-install.mjs): installs
 * the managed agent browser, or brings an installed one to the pinned version, so an
 * update through the installer keeps it current. Never fails the AgentPier
 * installation; it reports a status and, on failure, the message.
 */
export async function provisionAgentBrowser(
  {
    dataDir,
    enable = false,
    platform = process.platform,
    arch = process.arch,
    manifest = chromiumManifest,
  },
  { install = installChromium, fetchImpl = fetch } = {},
) {
  const root = path.join(dataDir, "clis");
  const installed = managedChromium(root);
  if (!enable && !installed) return null;
  if (installed?.version === manifest.version)
    return { status: "ready", version: installed.version };
  const reason = chromiumUnavailable(platform, arch, manifest);
  if (reason) return { status: "unavailable", message: reason };
  try {
    // Loaded on use: the installer scripts run before AgentPier's dependencies exist.
    const [{ run }, { cleanEnvironment }] = await Promise.all([
      import("./tool-run.js"),
      import("../accounts/account-store.js"),
    ]);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const result = await install({
      root,
      platform,
      arch,
      manifest,
      fetchImpl,
      run,
      env: cleanEnvironment(),
      signal: AbortSignal.timeout(15 * 60 * 1000),
    });
    return { status: "ready", version: result.version };
  } catch (error) {
    return { status: "failed", message: error.message };
  }
}
