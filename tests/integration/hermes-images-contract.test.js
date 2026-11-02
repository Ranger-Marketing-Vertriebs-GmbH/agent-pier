import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import {
  fakePng,
  startFakeChatgptOAuth,
  startFakeCodex,
} from "../helpers/fake-chatgpt.js";
import { hermesSkip, strayAfterStop } from "../helpers/hermes-native.js";
import { hermesFleetApp, json } from "../helpers/hermes-app.js";
import { eventually } from "../helpers/hermes-fake-runtime.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";
import { ChatGptAuth } from "../../server/features/model-logins/chatgpt-auth.js";
import { chatgptRoute } from "../../server/features/model-logins/chatgpt-proxy.js";
import { proxyAccess } from "../../server/features/assistants/proxy-access.js";
import { accountIdOf } from "../../server/features/assistants/model-accounts.js";

// Create images on the pinned Hermes (AGENTPIER_HERMES_CONTRACT_RUNTIME): an agent
// that chats with another model creates images with a ChatGPT login AgentPier holds.
// Hermes's bundled openai-codex image backend posts to AgentPier's runtime proxy
// with the proxy credential of its auth.json row; the proxy adds the login's token
// and sends it to a fake Codex backend on loopback (never OpenAI). The team plugin's
// guard asks AgentPier first (image-policy.js audits the generation), and its result
// hook shares the image into the chat. Synthetic tokens only.
const options = { skip: hermesSkip, timeout: contractTimeout(900000) };

test(
  "Hermes contract: an agent creates an image with a ChatGPT login AgentPier holds",
  options,
  async (t) => {
    const model = await startFakeModel();
    const codex = await startFakeCodex();
    const issuer = await startFakeChatgptOAuth();
    t.after(() => Promise.all([model.close(), codex.close(), issuer.close()]));
    const app = await hermesFleetApp(t, model);
    const { f, fleet, assistants } = app;
    const services = f.application;
    // The owner's ChatGPT login, held by AgentPier; a renewal would reach the fake.
    const vault = services.assistantModelAccounts.vault;
    vault.auth = new ChatGptAuth({ issuer: issuer.url });
    const pair = issuer.issue();
    const profileId = vault.save({
      access: pair.access_token,
      refresh: pair.refresh_token,
      expires: Date.now() + 24 * 3600_000,
      accountId: "acct-fixture",
      email: "owner@example.invalid",
    });
    // The proxy's ChatGPT route as the graph wires it, upstream the fake Codex.
    const access = proxyAccess({
      assistants,
      servers: services.assistantMcpServers,
      accountIdOf,
    });
    services.assistantRuntimeProxy.route(
      "chatgpt",
      chatgptRoute({ vault, upstream: codex.url, authorize: access.chatgpt, warn() {} }),
    );
    const audit = [];
    const original = assistants.audit;
    assistants.audit = Object.assign(Object.create(original || null), {
      append: (event) => {
        audit.push(event);
        return original?.append(event);
      },
    });

    const created = await app.createAgent({ name: "Hermes painter", shell: "off" });
    // A new agent starts without web tools; the owner switches Create images on.
    const agent = await json(
      await f.request(`/api/assistants/${created.id}`, {
        method: "PATCH",
        body: {
          revision: created.revision,
          capabilities: { ...created.capabilities, createImages: true },
          confirmRestart: true,
        },
      }),
    );
    assert.equal(agent.capabilities.createImages, true);
    const paths = fleet.sets.get(agent.runtimeAgentId).supervisor.agentPaths();
    const read = (name) => fs.readFileSync(path.join(paths.hermesHome, name), "utf8");
    await eventually(
      () =>
        !readHermesConfig(read("config.yaml")).agent.disabled_toolsets.includes(
          "image_gen",
        ),
      60000,
      "image creation in the agent's home",
    );
    await app.ready(agent);
    const config = readHermesConfig(read("config.yaml"));
    assert.equal(config.image_gen.provider, "openai-codex");
    assert.ok(!config.agent.disabled_toolsets.includes("image_gen"));
    assert.equal(config.model.provider, "custom", "the agent keeps its own model");
    assert.match(
      read(".env"),
      /HERMES_CODEX_BASE_URL='http:\/\/127\.0\.0\.1:\d+\/chatgpt\/codex'/,
    );
    const [row] = JSON.parse(read("auth.json")).credential_pool["openai-codex"];
    assert.match(row.access_token, /^apx1\./);
    // The credential names this agent and the image login, and nothing else.
    const scope = JSON.parse(
      Buffer.from(row.access_token.split(".")[1], "base64url").toString("utf8"),
    );
    assert.deepEqual(scope, ["chatgpt", agent.runtimeAgentId, profileId]);
    for (const name of ["config.yaml", ".env", "auth.json"]) {
      assert.ok(!read(name).includes(pair.access_token), `no access token in ${name}`);
      assert.ok(!read(name).includes(pair.refresh_token), `no refresh token in ${name}`);
    }
    assert.match(read("SOUL.md"), /image_generate creates and edits images/);

    const chat = await app.chat(agent);
    await chat.send(
      "draw",
      `Draw a red square.\nCALL: image_generate ${JSON.stringify({ prompt: "a red square", aspect_ratio: "square" })}`,
    );
    const done = await chat.reply("TOOL_DONE");
    assert.match(done.text, /"success": true/);
    const offered = model.requests
      .flatMap((r) => (r.body?.tools || []).map((tool) => tool.function?.name))
      .filter(Boolean);
    assert.ok(offered.includes("image_generate"), JSON.stringify([...new Set(offered)]));

    // The request went through the proxy with the login's token and identity.
    const generated = codex.requests.filter(
      (r) => r.url === "/backend-api/codex/images/generations",
    );
    assert.equal(generated.length, 1, JSON.stringify(codex.requests.map((r) => r.url)));
    assert.equal(generated[0].headers.authorization, `Bearer ${pair.access_token}`);
    assert.equal(generated[0].headers["chatgpt-account-id"], "acct-fixture");
    assert.equal(generated[0].body.prompt, "a red square");
    assert.equal(generated[0].body.model, "gpt-image-2");
    // The guard audited one generation, without the prompt.
    assert.deepEqual(
      audit.filter((e) => e.details?.kind === "image-generation").map((e) => e.details),
      [{ kind: "image-generation" }],
    );
    // The image reached the chat as a file of the agent's own folder.
    const folder = path.join(paths.workspace, "generated-images");
    const [file] = fs.readdirSync(folder);
    assert.match(file, /\.png$/);
    assert.equal(
      fs.readFileSync(path.join(folder, file)).toString("base64"),
      fakePng,
      "the image the Codex backend made",
    );
    const shared = assistants.attachments.shared.forConversation(chat.chat.id);
    assert.deepEqual(
      shared.flatMap((m) => m.attachments.map((a) => a.name)),
      [file],
    );

    // A local reference outside its folder never leaves the host.
    // Once the first turn has ended (an agent runs one request at a time).
    const before = codex.requests.length;
    const outside = `Edit this.\nCALL: image_generate ${JSON.stringify({ prompt: "edit", image_url: "/etc/hosts" })}`;
    await eventually(
      async () => {
        const sent = await f.request(
          `/api/assistant-conversations/${chat.chat.id}/messages`,
          { method: "POST", body: { clientRequestId: "outside", text: outside } },
        );
        if (sent.status === 409) return false;
        assert.ok([200, 201, 202].includes(sent.status), await sent.text());
        return true;
      },
      120000,
      "the first turn to end",
    );
    const refused = await chat.reply(/TOOL_DONE.*work folder/s);
    assert.match(refused.text, /absolute paths to files in your work folder/);
    assert.equal(codex.requests.length, before, "no request for the refused call");

    await fleet.close();
    assert.deepEqual(await strayAfterStop({ root: path.dirname(paths.hermesHome) }), []);
  },
);
