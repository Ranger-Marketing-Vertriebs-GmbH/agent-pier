import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import { startFakeChatgptOAuth, startFakeCodex } from "../helpers/fake-chatgpt.js";
import {
  collectEvents,
  endsRun,
  hermesSandbox,
  hermesSkip,
  startHermes,
} from "../helpers/hermes-native.js";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import { ChatGptAuth } from "../../server/features/model-logins/chatgpt-auth.js";
import { ChatGptVault } from "../../server/features/model-logins/chatgpt-vault.js";
import { RuntimeProxy } from "../../server/features/model-logins/runtime-proxy.js";
import { chatgptRoute } from "../../server/features/model-logins/chatgpt-proxy.js";

// A ChatGPT login AgentPier holds, used by the pinned Hermes through AgentPier's
// model proxy (hermes-config/model.js): Hermes runs its own openai-codex provider
// against HERMES_CODEX_BASE_URL with the proxy credential from its credential pool;
// the proxy injects the account's token and identity. Synthetic tokens only: a fake
// Codex backend and a fake OpenAI issuer on loopback, never OpenAI.
const options = { skip: hermesSkip, timeout: contractTimeout(600000) };
const agentId = "hermes-chatgpt";
const modelId = "gpt-5.4";

function chatgptAgent(profileId) {
  return desiredAgent(
    {
      id: agentId,
      name: `Agent ${agentId}`,
      runtimeAgentId: agentId,
      revision: 2,
      capabilities: { memory: true },
      shell: "approval",
    },
    {
      instructions: `# ${agentId}\n\nYou help the owner.\n`,
      model: {
        ref: `openai/${modelId}@${profileId}`,
        agentRuntime: { model: `openai/${modelId}`, id: "openclaw" },
        chatgpt: { profileId, modelId, holder: "agentpier" },
      },
    },
  );
}

test(
  "Hermes contract: a ChatGPT login AgentPier holds runs turns through the model proxy",
  options,
  async (t) => {
    const dirs = hermesSandbox(t);
    const model = await startFakeModel();
    const codex = await startFakeCodex({ models: [modelId] });
    const issuer = await startFakeChatgptOAuth();
    const vault = new ChatGptVault({
      dataDir: dirs.root,
      auth: new ChatGptAuth({ issuer: issuer.url }),
      schedule: false,
      warn: () => {},
    });
    const pair = issuer.issue();
    const profileId = vault.save({
      access: pair.access_token,
      refresh: pair.refresh_token,
      expires: Date.now() + 3600_000,
      accountId: "acct-fixture",
      email: "owner@example.invalid",
    });
    const proxy = new RuntimeProxy({ dataDir: dirs.root, warn: () => {} });
    proxy.route("chatgpt", chatgptRoute({ vault, upstream: codex.url, warn: () => {} }));
    const url = await proxy.start();
    t.after(async () => {
      await proxy.close();
      vault.close();
      await Promise.all([model.close(), codex.close(), issuer.close()]);
    });
    const hermes = await startHermes(t, dirs, { agentId, model });
    const { runtime, sessions, events, agent } = hermes;
    const applied = await runtime.config.apply({
      desired: chatgptAgent(profileId),
      modelProxy: {
        url,
        credentialFor: (id) => proxy.credential(["chatgpt", agentId, id]),
      },
    });
    assert.equal(applied.restarted, true);
    assert.ok(applied.written.includes("auth.json"), JSON.stringify(applied.written));

    // The home names the proxy and its credential, never the account's tokens.
    const home = Object.fromEntries(
      ["config.yaml", ".env", "auth.json"].map((name) => [
        name,
        fs.readFileSync(path.join(agent.hermesHome, name), "utf8"),
      ]),
    );
    assert.match(home["config.yaml"], /provider: openai-codex/);
    assert.match(
      home[".env"],
      /HERMES_CODEX_BASE_URL='http:\/\/127\.0\.0\.1:\d+\/chatgpt\/codex'/,
    );
    const pool = JSON.parse(home["auth.json"]).credential_pool["openai-codex"];
    assert.equal(pool[0].auth_type, "api_key");
    assert.match(pool[0].access_token, /^apx1\./);
    for (const text of Object.values(home)) {
      assert.ok(!text.includes(pair.access_token), "no access token in the home");
      assert.ok(!text.includes(pair.refresh_token), "no refresh token in the home");
    }

    const { key } = await sessions.create({
      agentId,
      label: "codex",
      idempotencyKey: "c1",
    });
    const turn = async (message, runId) => {
      const run = collectEvents(events);
      await sessions.send({ key, turn: { message }, idempotencyKey: runId });
      return run.until(endsRun(runId));
    };
    const first = await turn("hello codex", "run-c1");
    assert.equal(first.kind, "finished", JSON.stringify(first.payload));
    assert.match(first.payload.text, /CODEX: hello codex/);
    const responses = codex.requests.filter(
      (r) => r.url === "/backend-api/codex/responses",
    );
    assert.ok(responses.length >= 1);
    const [sent] = responses;
    assert.equal(sent.headers.authorization, `Bearer ${pair.access_token}`);
    assert.equal(sent.headers["chatgpt-account-id"], "acct-fixture");
    assert.equal(sent.body.model, modelId);
    // Codex request shaping stays on behind the proxy (store false, instructions).
    assert.equal(sent.body.store, false);
    assert.equal(typeof sent.body.instructions, "string");
    t.diagnostic(`codex requests=${JSON.stringify(codex.requests.map((r) => r.url))}`);

    // A revoked token: the proxy renews once and replays; Hermes never refreshes.
    codex.reject.add(vault.accessOf(profileId).access);
    const second = await turn("after renewal", "run-c2");
    assert.equal(second.kind, "finished", JSON.stringify(second.payload));
    assert.match(second.payload.text, /CODEX: after renewal/);
    assert.equal(issuer.state.refreshes, 1, "AgentPier renewed the login once");
    assert.ok(
      issuer.state.calls.every(
        (c) => !String(c.headers["user-agent"]).includes("Hermes"),
      ),
      "Hermes never called the issuer",
    );
  },
);
