import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reaManifest, reaPlatform } from "./rea-manifest.js";

const darwinMajor = () =>
  process.platform === "darwin" ? Number(os.release().split(".")[0]) : NaN;
const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const link = (root, id) => {
  try {
    return fs.lstatSync(path.join(root, id)).isSymbolicLink();
  } catch {
    return false;
  }
};

function readSettings(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObject(saved) ? saved : {};
  } catch {
    return {};
  }
}

// What the server finds at its next start (ReaTool.start): Core and the server row
// need AgentPier's dependencies, so the installers only leave this request.
function writeRequest(directory, file, saved) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const body = {
    ...saved,
    requested: {
      components: { ghidra: true, frida: true },
      settings: { provider: "ghidra" },
    },
  };
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/**
 * Installer step for `--with-rea` (setup.sh, release-install.mjs): installs Ghidra and
 * the JDK of the managed REA tool, or brings an installed REA's to the pinned versions.
 * REA Core and its server row need AgentPier's dependencies and a running server, so
 * they finish at the next server start from the request left in REA's settings file.
 * Never fails the AgentPier installation; it reports a status and, on failure, the
 * message.
 */
export async function provisionRea(
  {
    dataDir,
    enable = false,
    platform = process.platform,
    arch = process.arch,
    darwinMajor: major = darwinMajor(),
    manifest = reaManifest,
  },
  { install, fetchImpl = fetch } = {},
) {
  const root = path.join(dataDir, "clis");
  const directory = path.join(dataDir, "rea");
  const file = path.join(directory, "settings.json");
  const saved = readSettings(file);
  const hasRow = typeof saved.serverId === "string" && saved.serverId !== "";
  const hasComponents = link(root, "rea-ghidra") || link(root, "rea-jdk");
  const installed = hasRow || hasComponents;
  if (!enable && !installed) return null;
  const host = reaPlatform({ platform, arch, darwinMajor: major }, manifest);
  if (!host.available) return { status: "unavailable", message: host.reason };
  try {
    if (enable && !installed) writeRequest(directory, file, saved);
    // An installed REA keeps the owner's choice: `--with-rea` never adds Ghidra to it.
    const wanted = installed
      ? saved.components?.ghidra === true || hasComponents
      : enable;
    if (!wanted) return { status: installed ? "ready" : "pending", ghidra: null };
    if (!host.ghidra)
      return {
        status: installed ? "ready" : "pending",
        ghidra: null,
        ...(host.ghidraReason ? { message: host.ghidraReason } : {}),
      };
    // Loaded on use: the installer scripts run before AgentPier's dependencies exist.
    const [components, { run }, { cleanEnvironment }] = await Promise.all([
      import("./rea-components.js"),
      import("./tool-run.js"),
      import("../accounts/account-store.js"),
    ]);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const env = cleanEnvironment();
    const place = install ?? components.installReaComponent;
    const parts = [
      ["rea-jdk", host.ghidra.jdk, manifest.jdk.version],
      ["rea-ghidra", host.ghidra.entry, manifest.ghidra.version],
    ];
    for (const [id, entry, version] of parts) {
      if (components.managedReaComponent(root, id)?.version === version) continue;
      await place({
        root,
        id,
        version,
        entry,
        fetchImpl,
        run,
        env,
        platform,
        signal: AbortSignal.timeout(30 * 60 * 1000),
      });
    }
    return { status: installed ? "ready" : "pending", ghidra: manifest.ghidra.version };
  } catch (error) {
    return { status: "failed", message: error.message };
  }
}
