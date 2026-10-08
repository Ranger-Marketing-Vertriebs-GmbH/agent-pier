import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { applicationFixture } from "../helpers/application.js";
import { scriptedUpstream, sse } from "../helpers/scripted-upstream.js";
import { loadFixture } from "../helpers/protocol-adapter.js";
import { until, waitForJson } from "../helpers/adapter-process.js";

const fakeCli = fileURLToPath(new URL("../helpers/fake-cli.mjs", import.meta.url));
const KEY = "fixture-adapter-session-key";
const BODY = JSON.stringify(loadFixture("clients/claude-code/text.json").body);

/** Chat-only endpoint with Claude Code routed through the adapter explicitly (auto is off in PR 2). */
async function adapterConnection(f, up) {
  const created = await f.request("/api/provider-connections", {
    method: "POST",
    body: {
      name: "Chat box",
      providerId: "endpoint",
      apiKey: KEY,
      endpoint: {
        preset: "custom",
        openaiBaseUrl: `${up.base}/v1`,
        anthropicBaseUrl: null,
        protocols: { messages: false, responses: false, chatCompletions: true },
        authHeader: null,
        routing: { claude: "adapter:chatCompletions" },
        models: [
          {
            modelId: "qwen3",
            label: "Qwen",
            contextTokens: 32768,
            outputTokens: null,
            source: "manual",
            contextEdited: true,
          },
        ],
        lastTest: null,
      },
    },
  });
  assert.equal(created.status, 201, await created.clone().text());
  return created.json();
}

async function startSession(f, connection) {
  const started = await f.request("/api/sessions", {
    method: "POST",
    body: {
      tool: "claude",
      providerConnectionId: connection.id,
      providerModelId: "qwen3",
      cwd: f.home,
      agentbus: false,
    },
  });
  assert.equal(started.status, 201, await started.clone().text());
  return started.json();
}

/** Replaces the CLI with the fake CLI while keeping the prepared env and adapter block. */
async function useFakeCli(f, out) {
  const version = path.join(f.root, "version-fixture");
  await fs.writeFile(version, "#!/bin/sh\nprintf '2.1.291\\n'\n", { mode: 0o755 });
  const original = f.application.accounts.command.bind(f.application.accounts);
  f.application.accounts.command = (id, _binaries, login, mode, options) => {
    const prepared = original(id, { claude: version }, login, mode, options);
    assert.ok(prepared.adapter, "adapter block prepared");
    return {
      ...prepared,
      command: process.execPath,
      args: [fakeCli, out, "call"],
      env: { ...prepared.env, FAKE_CLI_BODY: BODY },
    };
  };
}

async function noKeyAnywhere(f) {
  const sessionsDir = path.join(f.dataDir, "sessions");
  const files = await fs.readdir(sessionsDir);
  assert.equal(
    files.some((n) => n.endsWith(".launch.json")),
    false,
    "payload consumed",
  );
  for (const name of files)
    // includes <id>.adapter.json: diagnostics never hold the key
    assert.equal(
      (await fs.readFile(path.join(sessionsDir, name), "utf8")).includes(KEY),
      false,
      name,
    );
  const state = await (await f.request("/api/state")).json();
  assert.equal(JSON.stringify(state).includes(KEY), false);
}

test("a Claude Code session on a Chat-only endpoint runs through the adapter without exposing the key", async (t) => {
  const f = await applicationFixture(t);
  const up = await scriptedUpstream(t, (_e, res) =>
    sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const connection = await adapterConnection(f, up);
  assert.deepEqual(connection.toolRoutes.claude, {
    mode: "adapter",
    source: "chatCompletions",
  });
  const out = path.join(f.root, "cli.json");
  await useFakeCli(f, out);
  const session = await startSession(f, connection);
  assert.deepEqual(session.provider.route, {
    mode: "adapter",
    source: "chatCompletions",
  });
  const record = await waitForJson(out);
  assert.match(record.calls[0].text, /message_stop/);
  assert.equal(up.seen[0].headers.authorization, `Bearer ${KEY}`);
  await noKeyAnywhere(f);
});

test("removing a finished adapter session deletes its diagnostics file", async (t) => {
  const f = await applicationFixture(t);
  const up = await scriptedUpstream(t, (_e, res) =>
    sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const connection = await adapterConnection(f, up);
  const out = path.join(f.root, "cli.json");
  await useFakeCli(f, out);
  const session = await startSession(f, connection);
  await waitForJson(out);
  const diagnostics = path.join(f.dataDir, "sessions", `${session.id}.adapter.json`);
  await until(
    async () => (await f.application.sessions.get(session.id)).status === "stopped",
    10_000,
  );
  await until(
    () =>
      fs.access(diagnostics).then(
        () => true,
        () => false,
      ),
    5000,
  ); // final flush
  assert.equal(
    (await f.request(`/api/sessions/${session.id}`, { method: "DELETE" })).status,
    204,
  );
  await assert.rejects(fs.access(diagnostics));
});

test("reload starts a new adapter with a new token and stops the old one", async (t) => {
  const f = await applicationFixture(t);
  const app = f.application;
  const up = await scriptedUpstream(t, (_e, res) =>
    sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const connection = await adapterConnection(f, up);
  // Synthetic Claude Code (pattern of session-reload-lifecycle.test.js): records its native
  // session so reload is eligible, calls the adapter once per launch, then keeps running.
  const cli = path.join(f.root, "synthetic-claude.mjs");
  const capture = path.join(f.root, "launches.jsonl");
  const bindingModule = new URL(
    "../../server/features/sessions/native-session-binding.js",
    import.meta.url,
  ).href;
  await fs.writeFile(
    cli,
    `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import { recordNativeSession } from ${JSON.stringify(bindingModule)};
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.291'); process.exit(0); }
const resumed = args.includes('--resume');
const nativeId = args[args.indexOf(resumed ? '--resume' : '--session-id') + 1];
const cwd = process.cwd();
const folder = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(folder, { recursive: true });
const history = path.join(folder, nativeId + '.jsonl');
if (!resumed) fs.writeFileSync(history, JSON.stringify({ type: 'user', uuid: 'fixture-message', sessionId: nativeId, cwd, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Keep this conversation' } }) + '\\n');
recordNativeSession({ session_id: nativeId, cwd }, process.env, { pid: process.pid });
const url = process.env.ANTHROPIC_BASE_URL, token = process.env.ANTHROPIC_AUTH_TOKEN;
const res = await fetch(url + '/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: ${JSON.stringify(BODY)} });
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ resumed, url, token, status: res.status, text: await res.text() }) + '\\n');
process.stdin.resume();
setInterval(() => {}, 1000);
`,
    { mode: 0o700 },
  );
  const original = app.accounts.command.bind(app.accounts);
  app.accounts.command = (id, _binaries, login, mode, options) =>
    original(id, { claude: cli }, login, mode, options);
  const session = await startSession(f, connection);
  const rows = async () =>
    (await fs.readFile(capture, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  await until(async () => (await rows()).length === 1, 10_000);
  const endpoint = `/api/sessions/${session.id}/reload`;
  await until(async () => (await (await f.request(endpoint)).json()).eligible, 10_000);
  const reload = await f.request(endpoint, {
    method: "POST",
    body: { requestId: randomUUID(), mode: "now", interrupt: true },
  });
  assert.ok(reload.ok, await reload.clone().text());
  await until(
    async () => (await (await f.request(endpoint)).json()).state === "completed",
    15_000,
  );
  await until(async () => (await rows()).length === 2, 10_000);
  const [first, second] = await rows();
  assert.equal(second.resumed, true);
  for (const row of [first, second]) {
    assert.equal(row.status, 200);
    assert.match(row.text, /message_stop/);
  }
  assert.notEqual(second.token, first.token, "every launch gets a fresh session token");
  // The first adapter is gone: its URL refuses connections, or (same port reused) rejects the old token.
  const old = await fetch(`${first.url}/api/hello`, {
    headers: { authorization: `Bearer ${first.token}` },
  }).catch(() => null);
  assert.ok(
    old === null || old.status === 401,
    `old adapter still answers: ${old?.status}`,
  );
  const current = await app.sessions.get(session.id);
  assert.deepEqual(current.provider.route, {
    mode: "adapter",
    source: "chatCompletions",
  });
  await noKeyAnywhere(f);
});
