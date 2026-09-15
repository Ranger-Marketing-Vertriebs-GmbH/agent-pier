import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { digest } from "../../server/features/operations/files.js";
import { installRelease } from "../../scripts/release-install.mjs";
export async function setupFixture(t) {
  const temporary = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "ap-setup-")),
  );
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const installRoot = path.join(temporary, "install"),
    dataDir = path.join(temporary, "data");
  async function archive(version) {
    const manifest = {
      version,
      schemaVersion: 1,
      schemaMin: 1,
      schemaMax: 1,
      platform: `${process.platform}-${process.arch}`,
    };
    const files = Object.entries({
      "release.json": JSON.stringify(manifest),
      "bin/node": "fixture",
      "server/index.js": "fixture",
      "package.json": '{"type":"module"}',
      "dist/index.html": "fixture",
      "node_modules/node-pty/package.json": "{}",
    }).map(([name, content]) => ({
      path: name,
      content: Buffer.from(content).toString("base64"),
      sha256: digest(Buffer.from(content)),
      mode: name === "bin/node" ? 0o755 : 0o600,
    }));
    const file = path.join(temporary, `${version}.aprelease`);
    await fs.writeFile(
      file,
      gzipSync(
        JSON.stringify({ format: "agentpier-release", version: 1, manifest, files }),
      ),
    );
    return file;
  }
  const stageCalls = [],
    restartCalls = [];
  const state = { service: "missing", listener: false, healthy: true };
  const dependencies = {
    run: async () => ({ stdout: "fixture" }),
    releaseOptions: { smoke: async (directory) => stageCalls.push(directory) },
    inspectService: async () => ({ state: state.service, listener: state.listener }),
    serviceRunner: async (input) => {
      restartCalls.push(input);
      state.service = "matching";
      state.listener = true;
    },
    health: async () => state.healthy,
    home: temporary,
  };
  const options = {
    archive: await archive("1.0.0"),
    installRoot,
    dataDir,
    resume: true,
    service: true,
  };
  return {
    temporary,
    installRoot,
    dataDir,
    archive,
    options,
    dependencies,
    state,
    stageCalls,
    restartCalls,
    install: (overrides = {}, injected = {}) =>
      installRelease({ ...options, ...overrides }, { ...dependencies, ...injected }),
  };
}
