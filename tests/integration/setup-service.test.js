import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setupFixture } from "../helpers/setup-fixture.js";
import { renderSystemdUnit } from "../../scripts/service.mjs";
import { inspectSetupService } from "../../scripts/setup-service.mjs";
for (const scenario of [
  "missing",
  "stopped",
  "healthy",
  "foreign-listener",
  "foreign-data",
]) {
  test(`Linux service inspection ${scenario} uses proc ownership without new tools`, async (t) => {
    const f = await setupFixture(t);
    const procRoot = path.join(f.temporary, "proc");
    await fs.mkdir(path.join(procRoot, "net"), { recursive: true });
    const listening = ["healthy", "foreign-listener", "foreign-data"].includes(scenario);
    const socket =
      "0: 0100007F:111C 00000000:0000 0A 00000000:00000000 00:00000000 00000000 501 0 12345\n";
    await fs.writeFile(
      path.join(procRoot, "net/tcp"),
      `header\n${listening ? socket : ""}`,
    );
    await fs.writeFile(path.join(procRoot, "net/tcp6"), "header\n");
    await fs.mkdir(path.join(procRoot, "123/fd"), { recursive: true });
    if (scenario === "healthy")
      await fs.symlink("socket:[12345]", path.join(procRoot, "123/fd/5"));
    const directory = path.join(f.temporary, ".config/systemd/user");
    await fs.mkdir(directory, { recursive: true });
    const launcher = path.join(f.installRoot, "bin/agentpier");
    if (scenario !== "missing")
      await fs.writeFile(
        path.join(directory, "dev.agentpier.server.service"),
        renderSystemdUnit({
          projectDir: path.join(f.installRoot, "current"),
          node: path.join(f.installRoot, "current/bin/node"),
          launcher,
          installRoot: f.installRoot,
          dataDir: f.dataDir,
          channel: "https://ongoing.test/releases/",
          envPath: "/usr/bin",
        }),
      );
    const run = async (command) => {
      assert.equal(command, "systemctl");
      return {
        stdout: `MainPID=${listening ? "123" : "0"}\nExecStart={ path=${launcher} ; argv[]=${launcher} ; }\nEnvironment=AGENTPIER_INSTALL_ROOT=${f.installRoot} AGENTPIER_DATA_DIR=${f.dataDir}${scenario === "foreign-data" ? "-other" : ""}\n`,
      };
    };
    const result = await inspectSetupService({
      installRoot: f.installRoot,
      dataDir: f.dataDir,
      home: f.temporary,
      env: {},
      platform: "linux",
      procRoot,
      run,
    });
    assert.equal(
      result.state,
      scenario === "missing"
        ? "missing"
        : scenario.startsWith("foreign")
          ? "conflict"
          : "matching",
    );
    if (scenario === "healthy") {
      assert.equal(result.listener, true);
      assert.equal(result.channel, "https://ongoing.test/releases/");
    }
  });
}
