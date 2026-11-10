import fs from "node:fs";
import path from "node:path";
import yazl from "yazl";
import { CraftTool } from "../../server/features/tools/craft-tool.js";
import { reaFixture } from "./rea-tool-fixture.js";
import { tarGz } from "./tar-fixture.js";

const release = (version) =>
  `https://github.com/storytold/craft-anything/releases/download/v${version}`;
const script = (version) => `#!/bin/sh\necho "craft-anything-cli ${version}"\n`;

const zip = (top, version) =>
  new Promise((resolve) => {
    const archive = new yazl.ZipFile();
    archive.addBuffer(Buffer.from(script(version)), `${top}/craft-anything-cli`, {
      mode: 0o100755,
    });
    const chunks = [];
    archive.outputStream.on("data", (chunk) => chunks.push(chunk));
    archive.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    archive.end();
  });

/**
 * The managed Craft Anything tool over reaFixture (real server store, central changes,
 * McpPackages; Ghidra and the JDK from the local stand-in). Craft Anything's archives
 * (a macOS zip for darwin-arm64, a Linux tarball for linux-arm64) are fake CLIs that
 * print their version, served locally per pinned version; nothing reaches the network.
 */
export async function craftFixture(t) {
  const f = await reaFixture(t);
  const manifests = new Map();
  /** A Craft Anything manifest pinning `version`, its archives served locally. */
  const craftManifest = async (version = "0.5.0") => {
    if (manifests.has(version)) return manifests.get(version);
    const macTop = `craft-anything-cli-${version}-macos-universal`;
    const linuxTop = `craft-anything-${version}-linux-aarch64`;
    const manifest = {
      checked: "2026-11-08",
      version,
      platforms: {
        "darwin-arm64": {
          kind: "zip",
          top: macTop,
          binary: "craft-anything-cli",
          installedSize: 2000,
          ...f.serve(`${release(version)}/${macTop}.zip`, await zip(macTop, version)),
        },
        "linux-arm64": {
          kind: "tar.gz",
          top: linuxTop,
          binary: "bin/craft-anything-cli",
          installedSize: 3000,
          remove: ["bin/craft-anything"],
          ...f.serve(
            `${release(version)}/${linuxTop}.tar.gz`,
            tarGz([
              {
                name: `${linuxTop}/bin/craft-anything-cli`,
                content: script(version),
                mode: 0o755,
              },
              { name: `${linuxTop}/bin/craft-anything`, content: "gui", mode: 0o755 },
            ]),
          ),
        },
      },
    };
    manifests.set(version, manifest);
    return manifest;
  };
  /** A CraftTool as the wiring builds it, pinned to `version` (default 0.5.0). */
  const tool = async ({ version, pins, ...options } = {}) => {
    const craft = new CraftTool({
      dataDir: f.s.dataDir,
      servers: f.s.servers,
      changes: f.s.changes,
      packages: f.s.packages,
      extensions: f.s.extensions,
      audit: { append: (event) => f.audits.push(event) },
      manifest: await craftManifest(version),
      reaManifest: f.manifest(pins),
      platform: "darwin",
      arch: "arm64",
      darwinMajor: 25,
      fetchImpl: f.fetchImpl,
      run: f.run,
      env: {},
      node: "/fake/bin/node",
      ...options,
    });
    craft.inUse = async () => f.busy.value;
    t.after(() => craft.close());
    return craft;
  };
  /** Installs Craft Anything (Ghidra unless told otherwise) and waits for the job. */
  const install = async (craft, body = {}) => {
    await craft.apply({ components: { ghidra: true }, confirmInstall: true, ...body });
    await craft.settled();
    return craft.state();
  };
  return {
    ...f,
    reaTool: f.tool,
    reaInstall: f.install,
    tool,
    install,
    craftManifest,
    root: path.join(f.s.dataDir, "clis"),
    configFile: path.join(f.s.dataDir, "craft-anything", "sessions", "config.toml"),
    /** The server the sessions' proxies run: `{ command, args, statusDir }`. */
    spec: () =>
      JSON.parse(
        fs.readFileSync(path.join(f.s.dataDir, "craft-anything", "server.json"), "utf8"),
      ),
  };
}
