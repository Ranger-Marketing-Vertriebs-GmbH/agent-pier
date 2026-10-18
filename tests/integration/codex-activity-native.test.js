import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { applicationFixture } from "../helpers/application.js";
import { createProbeProvider } from "../../scripts/probe-chat-tui-provider.mjs";
import { codexModelCatalog } from "../../server/features/providers/native-config.js";
import { codexSandboxArguments } from "../../server/lib/sandbox.js";

// Opt-in real CLI check: the installed Codex reports its turns through AgentPier's
// app-server proxy. All state and tmux processes belong to the fixture; the only
// model endpoint is a loopback synthetic provider.
test(
  "installed Codex reports working and idle through the request bridge",
  { skip: !process.env.AGENTPIER_TEST_CODEX_BIN, timeout: 60000 },
  async (t) => {
    const fixture = await applicationFixture(t);
    const provider = await createProbeProvider();
    t.after(() => provider.close());
    const { sessions, requests, accounts, bindings, activity } = fixture.application;
    const account = accounts.create({ name: "Activity fixture", tool: "codex" });
    const home = accounts.environment(account.id).CODEX_HOME;
    await fs.mkdir(home, { recursive: true });
    const catalogFile = path.join(home, "models.json");
    await fs.writeFile(
      catalogFile,
      JSON.stringify(
        codexModelCatalog(
          { modelId: "probe", label: "Probe" },
          { contextTokens: 272000, description: "Isolated probe", reasoning: false },
        ),
      ),
    );
    await fs.writeFile(
      path.join(home, "config.toml"),
      `model="probe"
model_provider="probe"
model_catalog_json=${JSON.stringify(catalogFile)}
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
    const id = randomUUID();
    const bound = await bindings.prepare({
      id,
      account,
      cwd: fixture.home,
      launch: {
        command: process.env.AGENTPIER_TEST_CODEX_BIN,
        args: ["--no-alt-screen", ...codexSandboxArguments()],
        env: {
          HOME: fixture.home,
          CODEX_HOME: home,
          PATH: process.env.PATH,
          TERM: "xterm-256color",
          LANG: "en_US.UTF-8",
        },
      },
    });
    // Activity comes from the proxy, not from hooks: leave out the binding's identity
    // hooks so the fresh CODEX_HOME shows no hook review.
    const args = bound.args.filter(
      (arg, i, all) => !/^hooks\./.test(arg) && !/^hooks\./.test(all[i + 1] || ""),
    );
    const bridged = await requests.prepare({
      id,
      account,
      cwd: fixture.home,
      launch: { ...bound, args },
    });
    const session = await sessions.create({
      id,
      name: "Activity fixture",
      tool: "codex",
      accountId: account.id,
      cwd: fixture.home,
      ...bridged,
      // tmux inherits the test runner's environment unless explicitly cleared.
      command: "/usr/bin/env",
      args: [
        "-i",
        ...Object.entries(bridged.env).map(([key, value]) => `${key}=${value}`),
        bridged.command,
        ...bridged.args,
      ],
      env: {},
    });
    const target = `${sessions.target(id)}:0.0`;
    const keys = (...values) => sessions.tmux(["send-keys", "-t", target, ...values]);
    async function waitForScreen(expected) {
      const deadline = Date.now() + 15000;
      let screen = "";
      while (Date.now() < deadline) {
        screen = await sessions.tmux(["capture-pane", "-p", "-t", target, "-S", "-100"]);
        if (screen.includes(expected)) return;
        if (/Yes, continue|Trust and continue/.test(screen)) {
          await delay(300);
          await keys("Enter");
        }
        await delay(50);
      }
      assert.fail(`Missing ${expected}: ${screen}`);
    }
    await waitForScreen("Ask Codex to do anything");
    const seen = new Set();
    let watching = true;
    t.after(() => {
      watching = false;
    });
    const watcher = (async () => {
      while (watching) {
        const value = bindings.activity(session);
        if (value) seen.add(`${value.state}:${value.event}`);
        await delay(5);
      }
    })();
    const buffer = `activity-${randomUUID()}`;
    await sessions.tmux(["load-buffer", "-b", buffer, "-"], {
      input: "AP_PROBE_ACTIVITY",
    });
    await sessions.tmux(["paste-buffer", "-d", "-p", "-r", "-b", buffer, "-t", target]);
    await delay(150);
    await keys("Enter");
    await waitForScreen("Synthetic response complete: AP_PROBE_ACTIVITY");
    const deadline = Date.now() + 10000;
    while (bindings.activity(session)?.state !== "idle" && Date.now() < deadline)
      await delay(50);
    watching = false;
    await watcher;
    assert.ok(
      [...seen].some((value) => value.startsWith("working:")),
      [...seen].join(", "),
    );
    assert.equal(bindings.activity(session).state, "idle");
    const read = await activity.read(await sessions.get(id));
    assert.deepEqual([read.state, read.source], ["idle", "hook"]);
  },
);
