import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { GatewayClient } from "../../server/features/assistants/gateway-client.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { patchConfig } from "../../server/features/assistants/openclaw-config/live-patch.js";
import { assistantModelServer } from "../helpers/assistant-model-server.js";

const installed = process.env.AGENTPIER_NATIVE_INTERFACES_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_NATIVE_INTERFACES_CONTRACT_RUNTIME",
  timeout: 300000,
};

async function gateway(t, prefix) {
  assert.ok(path.isAbsolute(installed));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const runtime = new RuntimeSupervisor({
    dataDir,
    install: async () => ({
      version: runtimeManifest.version,
      nodePath: path.join(installed, "node/bin/node"),
      entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
    }),
  });
  t.after(async () => {
    try {
      await runtime.close();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  await runtime.start();
  return { runtime, client: runtime.client, dataDir };
}

async function answer(promise) {
  try {
    return { result: await promise };
  } catch (error) {
    return { code: error.code, answered: error.answered === true };
  }
}

test("OpenClaw exposes the native interfaces AgentPier builds on", options, async (t) => {
  const { client } = await gateway(t, "native-interfaces-");

  // The locked core holds on the running Gateway.
  const { config } = await client.call("config.get", {});
  assert.equal(config.gateway.terminal.enabled, false);
  assert.equal(config.gateway.controlUi.enabled, false);

  // The hello advertises the methods and events AgentPier builds on.
  for (const method of [
    "config.get",
    "config.schema",
    "config.schema.lookup",
    "config.patch",
    "channels.pairing.list",
    "channels.pairing.approve",
    "channels.pairing.dismiss",
    "exec.approvals.get",
    "exec.approval.list",
    "exec.approval.get",
    "exec.approval.resolve",
  ])
    assert.equal(client.supports(method), true, method);
  for (const event of ["exec.approval.requested", "exec.approval.resolved"])
    assert.equal(client.features.events.has(event), true, event);
  // web.login.* is deliberately left out of discovery and needs a channel plugin.
  assert.equal(client.supports("web.login.start"), false);
  const login = await answer(client.call("web.login.start", {}));
  t.diagnostic(`web.login.start=${JSON.stringify(login)}`);
  assert.equal(login.answered, true);

  // The schema carries UI hints; a lookup reports how a path reloads.
  const schema = await client.call("config.schema", {});
  assert.equal(typeof schema.schema, "object");
  assert.equal(typeof schema.uiHints, "object");
  assert.equal(schema.version, runtimeManifest.version);
  const hot = await client.call("config.schema.lookup", {
    path: "agents.defaults.timeoutSeconds",
  });
  const cold = await client.call("config.schema.lookup", { path: "gateway.port" });
  t.diagnostic(`lookup hot=${JSON.stringify(hot)}`);
  t.diagnostic(`lookup cold=${JSON.stringify(cold)}`);
  assert.equal(hot.reloadKind, "hot");
  assert.equal(cold.reloadKind, "restart");
  assert.equal(cold.hint.label, "Gateway Port");

  // Shrinking an array needs its exact path in replacePaths.
  const allow = "agents.entries.main.tools.allow";
  const entry = (tools) => ({
    agents: { entries: { main: { tools: { allow: tools } } } },
  });
  await patchConfig(client, () => ({ patch: entry(["session_status", "exec"]) }));
  const unconfirmed = await answer(
    patchConfig(client, () => ({ patch: entry(["session_status"]) })),
  );
  t.diagnostic(`array shrink without replacePaths=${JSON.stringify(unconfirmed)}`);
  assert.equal(unconfirmed.code, "INVALID_REQUEST");
  await patchConfig(client, () => ({
    patch: entry(["session_status"]),
    replacePaths: [allow],
  }));
  const replaced = await client.call("config.get", {});
  assert.deepEqual(replaced.config.agents.entries.main.tools.allow, ["session_status"]);

  // A stale base hash is rejected, and patchConfig reports it as a conflict.
  const stale = await client.call("config.get", {});
  await client.call("config.patch", {
    baseHash: stale.hash,
    raw: JSON.stringify({ agents: { defaults: { timeoutSeconds: 601 } } }),
  });
  const rejected = await answer(
    client.call("config.patch", {
      baseHash: stale.hash,
      raw: JSON.stringify({ agents: { defaults: { timeoutSeconds: 602 } } }),
    }),
  );
  t.diagnostic(`stale hash=${JSON.stringify(rejected)}`);
  assert.deepEqual(rejected, { code: "INVALID_REQUEST", answered: true });
  // A write landing between patchConfig's read and its patch is a conflict.
  let raced = false;
  const racing = {
    async call(method, params) {
      if (method === "config.patch" && !raced) {
        raced = true;
        const latest = await client.call("config.get", {});
        await client.call("config.patch", {
          baseHash: latest.hash,
          raw: JSON.stringify({ agents: { defaults: { timeoutSeconds: 603 } } }),
        });
      }
      return client.call(method, params);
    },
  };
  await assert.rejects(
    patchConfig(racing, () => ({
      patch: { agents: { defaults: { timeoutSeconds: 604 } } },
    })),
    { status: 409 },
  );

  // The pairing queue answers with the scopes AgentPier requests.
  const pairing = await client.call("channels.pairing.list", {});
  t.diagnostic(`pairing=${JSON.stringify(pairing)}`);
  assert.deepEqual(pairing.requests, []);
  assert.ok(Array.isArray(pairing.accounts));
});

test(
  "an exec request in ask mode raises an approval event and a denied command never runs",
  options,
  async (t) => {
    const { client, dataDir } = await gateway(t, "native-exec-");
    const marker = path.join(dataDir, "ran");
    const model = await assistantModelServer({
      tool: { name: "exec", arguments: { command: `touch ${marker}` } },
    });
    t.after(() => model.close());
    // Test-only configuration: exec in ask mode for the default agent on the fake
    // model. It bypasses prepareRuntimeConfig on purpose.
    await patchConfig(client, () => ({
      patch: {
        models: {
          providers: {
            fixture: {
              baseUrl: model.url,
              api: "openai-completions",
              apiKey: "fixture-key",
              models: [
                {
                  id: "fixture-model",
                  name: "Fixture",
                  contextWindow: 32768,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
        agents: { defaults: { model: { primary: "fixture/fixture-model" } } },
        tools: { allow: ["session_status", "exec"], exec: { mode: "ask" } },
      },
    }));
    async function run(label) {
      const session = await client.call("sessions.create", { agentId: "main", label });
      const sent = await client.call("sessions.send", {
        key: session.key,
        message: "Run the command.",
        idempotencyKey: label,
      });
      return { session, sent };
    }
    const toolResult = (index) =>
      model.requests
        .flatMap((r) => r.messages || [])
        .filter((m) => m.role === "tool")
        .map((m) => String(m.content))
        .at(index);

    // AgentPier's own client declares no approval caps: nothing can answer, so
    // OpenClaw denies inline instead of waiting.
    const headless = await run("headless");
    const done = await client.call(
      "agent.wait",
      { runId: headless.sent.runId, timeoutMs: 45000 },
      { timeoutMs: 50000 },
    );
    assert.equal(done.status, "ok");
    t.diagnostic(`headless tool result=${JSON.stringify(toolResult(-1))}`);
    assert.match(toolResult(-1), /cannot wait for interactive exec approval/);
    assert.equal(fs.existsSync(marker), false);

    // A client declaring the "exec-approvals" cap receives the request.
    const approver = new GatewayClient({
      url: client.url,
      token: client.token,
      certPath: client.certPath,
      caps: ["exec-approvals"],
    });
    t.after(() => approver.close());
    await approver.connect();
    const events = [];
    approver.subscribe((frame) => events.push(frame));
    const interactive = await run("interactive");
    let requested;
    for (let i = 0; i < 300 && !requested; i++) {
      requested = events.find((e) => e.event === "exec.approval.requested");
      if (!requested) await delay(200);
    }
    assert.ok(requested, "an approval request arrived");
    t.diagnostic(`requested=${JSON.stringify(requested.payload)}`);
    const { id, request } = requested.payload;
    assert.equal(request.sessionKey, interactive.session.key);
    assert.equal(request.runId, interactive.sent.runId);
    assert.deepEqual(request.allowedDecisions, ["allow-once", "allow-always", "deny"]);
    assert.equal(fs.existsSync(marker), false, "nothing runs before a decision");
    const pending = await approver.call("exec.approval.get", { id });
    t.diagnostic(`exec.approval.get=${JSON.stringify(pending)}`);
    assert.equal(pending.id, id);
    assert.deepEqual(
      (await approver.call("exec.approval.list", {})).map((a) => a.id),
      [id],
    );
    const resolved = await approver.call("exec.approval.resolve", {
      id,
      decision: "deny",
    });
    t.diagnostic(`exec.approval.resolve=${JSON.stringify(resolved)}`);
    const settled = await approver.call(
      "agent.wait",
      { runId: interactive.sent.runId, timeoutMs: 45000 },
      { timeoutMs: 50000 },
    );
    assert.equal(settled.status, "ok");
    const outcome = events.find((e) => e.event === "exec.approval.resolved");
    t.diagnostic(`resolved=${JSON.stringify(outcome?.payload)}`);
    assert.equal(outcome?.payload.id, id);
    assert.equal(outcome.payload.decision, "deny");
    assert.match(toolResult(-1), /Exec denied .*user-denied/);
    assert.equal(fs.existsSync(marker), false, "a denied command never runs");
  },
);

const browserCandidates = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
];
const browserPath =
  process.env.AGENTPIER_TEST_BROWSER_PATH ||
  browserCandidates.find((candidate) => fs.existsSync(candidate));

// One agent turn on a fresh deterministic model that calls `tool` once. Returns the
// tools the model was offered and the tool result OpenClaw sent back.
async function callTool(t, client, tool, label) {
  const model = await assistantModelServer({ tool });
  t.after(() => model.close());
  const provider = `fixture-${label}`;
  await patchConfig(client, () => ({
    patch: {
      models: {
        providers: {
          [provider]: {
            baseUrl: model.url,
            api: "openai-completions",
            apiKey: "fixture-key",
            models: [
              {
                id: "fixture-model",
                name: "Fixture",
                input: ["text", "image"],
                contextWindow: 32768,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: `${provider}/fixture-model` },
          pdfModel: { primary: `${provider}/fixture-model` },
        },
      },
    },
  }));
  const session = await client.call("sessions.create", { agentId: "main", label });
  const sent = await client.call("sessions.send", {
    key: session.key,
    message: "Use the tool.",
    idempotencyKey: label,
  });
  const done = await client.call(
    "agent.wait",
    { runId: sent.runId, timeoutMs: 60000 },
    { timeoutMs: 65000 },
  );
  assert.equal(done.status, "ok", label);
  const result = model.requests
    .flatMap((r) => r.messages || [])
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content))
    .at(-1);
  t.diagnostic(`${label} result=${JSON.stringify(result?.slice(0, 600))}`);
  return { offered: model.requests[0]?.tools?.map((d) => d.function.name) ?? [], result };
}

test(
  "web tools and the isolated browser accept AgentPier's configuration",
  options,
  async (t) => {
    const { client, dataDir } = await gateway(t, "native-web-");
    for (const key of [
      "tools.web.search.provider",
      "tools.web.fetch",
      "tools.web.fetch.ssrfPolicy",
      "browser.enabled",
      "browser.executablePath",
      "browser.profiles",
      "plugins.allow",
      "plugins.load.paths",
    ]) {
      const lookup = await client.call("config.schema.lookup", { path: key });
      t.diagnostic(
        `lookup ${key} reloadKind=${lookup.reloadKind} children=${JSON.stringify(
          lookup.children?.map((c) => c.key),
        )}`,
      );
      assert.equal(lookup.reloadKind, "hot", key);
    }

    // DuckDuckGo, Perplexity and Brave are external plugins in 2026.9.8: naming a
    // provider whose plugin is not loaded is rejected.
    const missing = await answer(
      patchConfig(client, () => ({
        patch: { tools: { web: { search: { provider: "duckduckgo" } } } },
      })),
    );
    t.diagnostic(`duckduckgo without plugin=${JSON.stringify(missing)}`);
    assert.deepEqual(missing, { code: "INVALID_REQUEST", answered: true });

    const { config: before } = await client.call("config.get", {});
    // The bundled browser plugin otherwise adds a "user" profile that attaches to the
    // signed-in Chrome and a "chrome" extension relay; both are redefined as
    // isolated managed profiles.
    const port = before.gateway.port;
    const browser = {
      enabled: true,
      defaultProfile: "openclaw",
      evaluateEnabled: false,
      allowSystemProfileImport: false,
      headless: true,
      profiles: {
        user: { driver: "openclaw", cdpPort: port + 12 },
        chrome: { driver: "openclaw", cdpPort: port + 13 },
      },
      ...(browserPath && { executablePath: browserPath }),
    };
    const fetchPolicy = { dangerouslyAllowPrivateNetwork: false };
    await patchConfig(client, () => ({
      patch: {
        tools: {
          allow: [
            "session_status",
            "web_fetch",
            "web_search",
            "browser",
            "pdf",
            "view_image",
          ],
          web: { fetch: { ssrfPolicy: fetchPolicy } },
        },
        browser,
      },
    }));
    const { config } = await client.call("config.get", {});
    assert.deepEqual(config.tools.web.fetch.ssrfPolicy, fetchPolicy);
    assert.deepEqual(config.browser, browser);

    // A private address is refused before any request leaves the Gateway.
    let hits = 0;
    const page = http.createServer((req, res) => {
      hits++;
      res.setHeader("content-type", "text/html");
      res.end("<html><body><p>AGENTPIER_WEB_MARKER</p></body></html>");
    });
    await new Promise((r) => page.listen(0, "127.0.0.1", r));
    t.after(() => page.close());
    const local = `http://127.0.0.1:${page.address().port}/`;
    const fetched = await callTool(
      t,
      client,
      { name: "web_fetch", arguments: { url: local } },
      "fetch",
    );
    t.diagnostic(`offered=${JSON.stringify(fetched.offered)}`);
    for (const name of ["web_fetch", "browser", "pdf", "view_image"])
      assert.ok(fetched.offered.includes(name), name);
    assert.match(fetched.result, /"status": "error"/);
    assert.match(fetched.result, /Blocked hostname or private\/internal\/special-use IP/);
    assert.equal(hits, 0);

    await t.test("the browser runs only the isolated openclaw profile", async (st) => {
      if (!browserPath) return st.skip("no Chromium-based browser installed");
      const status = await callTool(
        st,
        client,
        { name: "browser", arguments: { action: "status" } },
        "status",
      );
      const state = JSON.parse(status.result);
      assert.equal(state.profile, "openclaw");
      assert.equal(state.driver, "openclaw");
      assert.equal(state.executablePath, browserPath);
      const listed = await callTool(
        st,
        client,
        { name: "browser", arguments: { action: "profiles" } },
        "profiles",
      );
      const { profiles } = JSON.parse(listed.result);
      assert.deepEqual(profiles.map((p) => p.name).sort(), [
        "chrome",
        "openclaw",
        "user",
      ]);
      for (const profile of profiles)
        assert.equal(profile.driver, "openclaw", profile.name);
      const imported = await callTool(
        st,
        client,
        { name: "browser", arguments: { action: "importprofile" } },
        "import",
      );
      assert.match(imported.result, /system profile import is disabled/);
      const blocked = await callTool(
        st,
        client,
        { name: "browser", arguments: { action: "open", url: local } },
        "blocked",
      );
      assert.match(blocked.result, /browser navigation blocked by policy/);
      assert.equal(hits, 0);

      // An explicitly allowed host opens in the managed profile below the data dir.
      await patchConfig(client, () => ({
        patch: { browser: { ssrfPolicy: { allowedHostnames: ["127.0.0.1"] } } },
      }));
      const stop = { name: "browser", arguments: { action: "stop" } };
      try {
        const opened = await callTool(
          st,
          client,
          { name: "browser", arguments: { action: "open", url: local } },
          "open",
        );
        assert.match(opened.result, new RegExp(`"url": "${local}"`));
        const snapshot = await callTool(
          st,
          client,
          { name: "browser", arguments: { action: "snapshot" } },
          "snapshot",
        );
        assert.match(snapshot.result, /AGENTPIER_WEB_MARKER/);
        const running = await callTool(
          st,
          client,
          { name: "browser", arguments: { action: "status" } },
          "running",
        );
        const { running: launched, userDataDir } = JSON.parse(running.result);
        assert.equal(launched, true);
        assert.ok(
          fs.realpathSync(userDataDir).startsWith(fs.realpathSync(dataDir)),
          userDataDir,
        );
      } finally {
        const stopped = await callTool(st, client, stop, "stop");
        assert.equal(JSON.parse(stopped.result).running, false);
      }
    });
  },
);
