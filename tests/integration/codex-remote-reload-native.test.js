import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { applicationFixture } from "../helpers/application.js";
import { createProbeProvider } from "../../scripts/probe-chat-tui-provider.mjs";
import { resumeLaunch } from "../../server/application/session-reload-launch.js";
import { codexSandboxArguments } from "../../server/lib/sandbox.js";

// Opt-in real CLI compatibility check. All state and tmux processes belong to
// the fixture; the only model endpoint is a loopback synthetic provider.
for (const mode of ["default", "yolo"])
  test(
    `installed Codex reloads ${mode} through the request bridge with history and permissions intact`,
    { skip: !process.env.AGENTPIER_TEST_CODEX_BIN, timeout: 60000 },
    async (t) => {
      const fixture = await applicationFixture(t);
      const provider = await createProbeProvider();
      t.after(() => provider.close());
      const { sessions, requests, accounts, bindings } = fixture.application;
      bindings.processOptions.executable = process.env.AGENTPIER_TEST_CODEX_BIN;
      const account = accounts.create({ name: "Reload fixture", tool: "codex" });
      const home = accounts.environment(account.id).CODEX_HOME;
      const attachments = path.join(fixture.home, "attachments");
      await fs.mkdir(home, { recursive: true });
      await fs.mkdir(attachments);
      await fs.writeFile(
        path.join(home, "config.toml"),
        `model="probe"
model_provider="probe"
check_for_update_on_startup=false
[model_providers.probe]
name="probe"
base_url="${provider.url}/v1"
wire_api="responses"
requires_openai_auth=false
[projects.${JSON.stringify(fixture.home)}]
trust_level="trusted"
`,
      );
      const env = {
        HOME: fixture.home,
        CODEX_HOME: home,
        PATH: process.env.PATH,
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
      };
      const original = {
        command: process.env.AGENTPIER_TEST_CODEX_BIN,
        args: [
          "--no-alt-screen",
          ...(mode === "yolo" ? ["--yolo"] : codexSandboxArguments()),
          "--add-dir",
          attachments,
        ],
        env,
      };
      const id = randomUUID();
      async function prepare(launch, replace = false) {
        const bridged = await requests.prepare({
          id,
          account,
          cwd: fixture.home,
          launch,
          replace,
        });
        // tmux inherits the test runner's environment unless explicitly cleared.
        return {
          ...bridged,
          command: "/usr/bin/env",
          args: [
            "-i",
            ...Object.entries(bridged.env).map(([key, value]) => `${key}=${value}`),
            bridged.command,
            ...bridged.args,
          ],
          env: {},
        };
      }
      const session = await sessions.create({
        id,
        name: "Reload fixture",
        tool: "codex",
        accountId: account.id,
        cwd: fixture.home,
        ...(await prepare(original)),
      });
      const target = `${sessions.target(id)}:0.0`;
      const capture = () =>
        sessions.tmux(["capture-pane", "-p", "-t", target, "-S", "-100"]);
      const keys = (...values) => sessions.tmux(["send-keys", "-t", target, ...values]);
      async function submit(text) {
        const buffer = `reload-${randomUUID()}`;
        await sessions.tmux(["load-buffer", "-b", buffer, "-"], { input: text });
        await sessions.tmux([
          "paste-buffer",
          "-d",
          "-p",
          "-r",
          "-b",
          buffer,
          "-t",
          target,
        ]);
        await delay(150);
        await keys("Enter");
      }
      async function waitForScreen(expected) {
        const deadline = Date.now() + 15000;
        let screen = "";
        while (Date.now() < deadline) {
          screen = await capture();
          assert.doesNotMatch(
            screen,
            /Pane is dead|Permission overrides are not supported/,
          );
          if (screen.includes(expected)) return;
          if (/Yes, continue|Trust and continue/.test(screen)) {
            await delay(300);
            await keys("Enter");
          }
          await delay(50);
        }
        assert.fail(`Missing ${expected}: ${screen}`);
      }
      await waitForScreen("Tip:");
      await submit("AP_PROBE_BEFORE_RELOAD");
      await waitForScreen("Synthetic response complete: AP_PROBE_BEFORE_RELOAD");
      const files = await fs.readdir(path.join(home, "sessions"), { recursive: true });
      const rollouts = files.filter((file) => file.endsWith(".jsonl"));
      assert.equal(rollouts.length, 1);
      const rollout = path.join(home, "sessions", rollouts[0]);
      const records = async () =>
        (await fs.readFile(rollout, "utf8")).trim().split("\n").map(JSON.parse);
      const before = await records();
      const nativeId = before.find((record) => record.type === "session_meta").payload.id;
      const context = (rows) =>
        rows.filter((row) => row.type === "turn_context").at(-1).payload;
      const permissions = context(before);
      assert.equal(
        permissions.sandbox_policy.type,
        mode === "yolo" ? "danger-full-access" : "workspace-write",
      );
      if (mode === "default")
        assert.ok(permissions.sandbox_policy.writable_roots.includes(attachments));
      await sessions.updateReload(id, { state: "reloading", nativeId });
      const resumed = await sessions.replace(id, async () => {
        await requests.discard(id);
        return prepare(resumeLaunch("codex", original, nativeId), true);
      });
      assert.equal(resumed.id, session.id);
      await waitForScreen("Synthetic response complete: AP_PROBE_BEFORE_RELOAD");
      assert.equal((await bindings.resolve(resumed, { forInput: true }))?.id, nativeId);
      await sessions.updateReload(id, { ...resumed.reload, state: "completed" });
      const delivery = await fixture.request(`/api/sessions/${id}/input`, {
        method: "POST",
        body: {
          deliveryId: randomUUID(),
          deliveryScope: JSON.stringify([id, account.id, "codex", session.createdAt]),
          text: "AP_PROBE_AFTER_RELOAD",
          submit: true,
        },
      });
      assert.equal((await delivery.json()).status, "handed-off");
      await waitForScreen("Synthetic response complete: AP_PROBE_AFTER_RELOAD");
      const after = context(await records());
      assert.deepEqual(after.sandbox_policy, permissions.sandbox_policy);
      assert.equal(after.approval_policy, permissions.approval_policy);
      assert.equal(after.model, permissions.model);
      assert.equal((await sessions.get(id)).status, "running");
    },
  );
