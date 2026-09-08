import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RequestBroker } from "../../server/features/requests/request-broker.js";

for (const tool of ["codex", "claude", "opencode", "shell"]) {
  for (const profile of ["local", "managed"]) {
    for (const mode of ["default", "permissive"]) {
      test(`request launch: ${tool}/${profile}/${mode} preserves native profile and adds only per-launch integration`, async (t) => {
        const root = await fs.mkdtemp(
          path.join(os.tmpdir(), "agentpier-request-launch-"),
        );
        const broker = new RequestBroker({ dataDir: root, sessions: {} });
        t.after(async () => {
          await broker.close();
          await fs.rm(root, { recursive: true, force: true });
        });
        const tuiConfig = path.join(root, "owned-tui.json");
        await fs.writeFile(
          tuiConfig,
          JSON.stringify({ plugin: ["existing-reader-plugin"], theme: "existing" }),
        );
        const env = {
          HOME: root,
          FIXTURE_KEY: "private-key",
          ...(profile === "managed" ? { CODEX_HOME: path.join(root, "profile") } : {}),
          ...(tool === "opencode" ? { OPENCODE_TUI_CONFIG: tuiConfig } : {}),
        };
        const args = mode === "permissive" ? ["--fixture-permissive"] : [];
        const original = { command: `/fixture/${tool}`, args, env };
        const launch = await broker.prepare({
          id: "session",
          account: { id: "account", tool },
          cwd: root,
          launch: original,
        });
        if (tool === "shell") {
          assert.deepEqual(launch, original);
          return;
        }
        assert.equal(launch.env.FIXTURE_KEY, "private-key");
        assert.equal(launch.env.CODEX_HOME, env.CODEX_HOME);
        assert.deepEqual(launch.nativeRequests, { enabled: true, version: 1 });
        const config = JSON.parse(
          await fs.readFile(launch.env.AGENTPIER_REQUEST_FILE, "utf8"),
        );
        if (tool === "codex") {
          assert.equal(launch.command, process.execPath);
          assert.equal(config.command, `/fixture/${tool}`);
          assert.deepEqual(config.args, args);
          assert.ok(launch.args[0].endsWith("codex-launch.js"));
        } else assert.equal(launch.command, original.command);
        if (tool === "claude") {
          const directory = launch.args.at(-1);
          const hooks = JSON.parse(
            await fs.readFile(path.join(directory, "hooks/hooks.json"), "utf8"),
          );
          assert.equal(hooks.hooks.PreToolUse[0].matcher, "AskUserQuestion");
          assert.equal(hooks.hooks.PermissionRequest[0].hooks[0].type, "command");
          assert.ok(launch.args.includes("--plugin-dir"));
        }
        if (tool === "opencode") {
          const config = JSON.parse(await fs.readFile(tuiConfig, "utf8"));
          assert.equal(config.plugin[0], "existing-reader-plugin");
          assert.equal(config.theme, "existing");
          assert.ok(config.plugin[1].endsWith("opencode-plugin.js"));
        }
      });
    }
  }
}
for (const tool of ["codex", "claude", "opencode"])
  for (const excluded of [{ purpose: "login" }, { headless: true }])
    test(`request bridge excludes ${tool}/${JSON.stringify(excluded)}`, async (t) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-request-exclude-"));
      const broker = new RequestBroker({ dataDir: root, sessions: {} });
      t.after(async () => {
        await broker.close();
        await fs.rm(root, { recursive: true, force: true });
      });
      const launch = { command: `/fixture/${tool}`, args: [], env: {} };
      assert.deepEqual(
        await broker.prepare({
          id: "fixture",
          account: { id: "account", tool },
          cwd: root,
          launch,
          ...excluded,
        }),
        launch,
      );
    });
