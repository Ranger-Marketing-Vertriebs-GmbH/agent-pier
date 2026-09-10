import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { digest } from "../../server/features/operations/files.js";
import { ensureDependencies, installRelease } from "../../scripts/release-install.mjs";
import { renderLaunchAgent, renderSystemdUnit } from "../../scripts/service.mjs";
for (const platform of ["darwin", "linux"])
  test(`installer ${platform} installs missing tools by default and supports check-only`, async () => {
    let available = false;
    const calls = [];
    const run = async (command, args) => {
      calls.push([command, args]);
      if (command === "tmux" && !available) throw Error("missing");
      if (args.includes("install")) available = true;
      return { stdout: "fixture" };
    };
    await assert.rejects(
      ensureDependencies({ platform, run, install: false }),
      /--install-dependencies/,
    );
    assert.equal(
      calls.some(([cmd]) => ["brew", "sudo"].includes(cmd)),
      false,
    );
    const result = await ensureDependencies({ platform, run, uid: 501 });
    assert.deepEqual(result.installed, ["tmux"]);
    assert.equal(
      calls.some(
        ([cmd, args]) =>
          cmd === (platform === "darwin" ? "brew" : "sudo") && args.includes("install"),
      ),
      true,
    );
  });
test("versioned service renderers follow the stable launcher and retain the data directory", () => {
  const input = {
    projectDir: "/install/current",
    node: "/install/current/bin/node",
    launcher: "/install/bin/agentpier",
    installRoot: "/install",
    dataDir: "/data",
    envPath: "/usr/bin",
    channel: "https://example.invalid/releases/",
  };
  const mac = renderLaunchAgent(input),
    linux = renderSystemdUnit(input);
  assert.match(mac, /<string>\/install\/bin\/agentpier<\/string>/);
  assert.doesNotMatch(mac, /<string>\/install\/current\/bin\/node<\/string>/);
  assert.match(linux, /ExecStart=:"\/install\/bin\/agentpier"/);
  assert.match(linux, /KillMode=process/);
  for (const result of [mac, linux]) {
    assert.match(result, /AGENTPIER_DATA_DIR/);
    assert.match(result, /AGENTPIER_INSTALL_ROOT/);
  }
});

for (const healthy of [false, true])
  test(`initial service installation requires health confirmation: ${healthy}`, async (t) => {
    const temporary = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-install-health-")),
    );
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const manifest = {
      version: "1.0.0",
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
    const archive = path.join(temporary, "fixture.aprelease");
    await fs.writeFile(
      archive,
      gzipSync(
        JSON.stringify({ format: "agentpier-release", version: 1, manifest, files }),
      ),
    );
    const installRoot = path.join(temporary, "install"),
      dataDir = path.join(temporary, "data");
    let serviceCalls = 0,
      healthCalls = 0;
    const result = installRelease(
      { archive, installRoot, dataDir, service: true },
      {
        run: async () => ({ stdout: "fixture" }),
        releaseOptions: { smoke: async () => {} },
        serviceRunner: async () => {
          serviceCalls++;
        },
        health: async (input) => {
          healthCalls++;
          assert.equal(serviceCalls, 1);
          assert.equal(input.version, "1.0.0");
          assert.equal(input.port, 4380);
          return healthy;
        },
      },
    );
    if (healthy) assert.equal((await result).serviceInstalled, true);
    else await assert.rejects(result, /health.*service logs/i);
    assert.equal(healthCalls, 1);
    assert.equal(await fs.readlink(path.join(installRoot, "current")), "releases/1.0.0");
    assert.ok((await fs.stat(dataDir)).isDirectory());
  });
