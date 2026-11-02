import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import { compileHome } from "../../server/features/assistants/runtimes/hermes/hermes-config/home.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";
import { proxyAccess } from "../../server/features/assistants/proxy-access.js";
import { accountIdOf } from "../../server/features/assistants/model-accounts.js";
import { hermesGuard } from "../../server/features/assistants/hermes-tool-guard.js";
import { attachHermesFleet } from "../../server/features/assistants/runtimes/runtime-for.js";
import { HermesFleet } from "../../server/features/assistants/runtimes/hermes/hermes-fleet.js";
import { imageRefusals } from "../../server/features/assistants/team-plugin/tool-guard.js";
import { imagesFor } from "../../web/features/assistants/runtime-capabilities.js";

// Create images on Hermes (hermes-config/images.js): Hermes's openai-codex image
// backend through AgentPier's runtime proxy with a ChatGPT login AgentPier holds,
// every call checked by the team plugin's guard and shared into the chat.
const login = "openai:owner@example.invalid";
const workspace = "/data/assistants/workspaces/a1";
const modelProxy = {
  url: "http://127.0.0.1:4999",
  credentialFor: (profileId) => `apx1.cred-${profileId}`,
};
const connection = { url: "http://127.0.0.1:4321", token: "bridge" };
const endpoint = {
  ref: "c1/m1",
  providerId: "c1",
  provider: {
    baseUrl: "https://llm.example.test/v1",
    api: "openai-completions",
    apiKey: "sk-endpoint",
    models: [{ id: "m1", name: "M1" }],
  },
};
const chatgpt = {
  ref: `openai/gpt-5.4@${login}`,
  agentRuntime: { model: "openai/gpt-5.4", id: "openclaw" },
  chatgpt: { profileId: login, modelId: "gpt-5.4", holder: "agentpier" },
};
const painter = (model, capabilities = { createImages: true }) =>
  desiredAgent(
    {
      id: "a1",
      name: "Painter",
      runtimeAgentId: "ap-a1",
      runtime: "hermes",
      revision: 1,
      shell: "off",
      capabilities: { memory: false, reminders: false, ...capabilities },
    },
    { model, instructions: "# Painter\n" },
  );
const compile = (agent, options = {}) =>
  compileHome(agent, {
    workspace,
    connection,
    modelProxy,
    imageLogin: login,
    ...options,
  });
const configOf = (home) => readHermesConfig(home.files["config.yaml"]);
const poolOf = (home) =>
  JSON.parse(home.files["auth.json"]).credential_pool["openai-codex"];

test("an agent on another model creates images with a row of its own", () => {
  const home = compile(painter(endpoint));
  const config = configOf(home);
  assert.equal(config.image_gen.provider, "openai-codex");
  assert.ok(!config.agent.disabled_toolsets.includes("image_gen"));
  assert.equal(config.model.provider, "custom", "its own model stays");
  assert.match(
    home.files[".env"],
    /HERMES_CODEX_BASE_URL='http:\/\/127\.0\.0\.1:4999\/chatgpt\/codex'/,
  );
  assert.match(home.files[".env"], /AUXILIARY_AGENTPIER_API_KEY='sk-endpoint'/);
  const [row] = poolOf(home);
  assert.equal(row.access_token, `apx1.cred-${login}`);
  assert.equal(row.auth_type, "api_key");
  assert.equal(home.auth.access_token, row.access_token);
  assert.ok(!home.unsupported.includes("createImages"));
  const tools = JSON.parse(home.files["plugins/agentpier-team/tools.json"]);
  assert.deepEqual(tools.images, { folder: workspace, share: "generated-images" });
  assert.match(
    home.files["plugins/agentpier-team/__init__.py"],
    /register_hook\("transform_tool_result", _image_result\)/,
  );
});

test("an agent on a ChatGPT login AgentPier holds uses that login's row for images", () => {
  const home = compile(painter(chatgpt));
  assert.equal(configOf(home).image_gen.provider, "openai-codex");
  assert.deepEqual(
    poolOf(home).map((row) => row.access_token),
    [`apx1.cred-${login}`],
  );
});

test("without a held login, the proxy or the guard, images stay off and are named", () => {
  for (const options of [
    { imageLogin: null },
    { modelProxy: undefined },
    { connection: undefined },
  ]) {
    const home = compile(painter(endpoint), options);
    const config = configOf(home);
    assert.ok(
      config.agent.disabled_toolsets.includes("image_gen"),
      JSON.stringify(options),
    );
    assert.equal(config.image_gen, undefined, "no empty image_gen section");
    assert.ok(home.unsupported.includes("createImages"));
    assert.ok(!(home.files[".env"] || "").includes("HERMES_CODEX_BASE_URL"));
    assert.equal(home.files["auth.json"], undefined);
  }
});

test("switching images off removes the row, the URL and the provider again", () => {
  const on = compile(painter(endpoint));
  const off = compile(painter(endpoint, { createImages: false }), {
    existing: {
      "config.yaml": on.files["config.yaml"],
      ".env": on.files[".env"],
      "auth.json": on.files["auth.json"],
    },
  });
  assert.equal(configOf(off).image_gen?.provider, undefined);
  assert.ok(configOf(off).agent.disabled_toolsets.includes("image_gen"));
  assert.ok(!off.files[".env"].includes("HERMES_CODEX_BASE_URL"));
  assert.deepEqual(poolOf(off) ?? [], []);
  assert.ok(!off.unsupported.includes("createImages"), "nothing wanted, nothing named");
});

test("the images endpoints need Create images and the login AgentPier chose", () => {
  const other = "openai:second@example.invalid";
  const agents = [
    {
      id: "a1",
      runtimeAgentId: "h-a",
      runtime: "hermes",
      capabilities: { memory: false, reminders: false, createImages: true },
      model: { connectionId: "c1" },
    },
    {
      id: "a2",
      runtimeAgentId: "h-b",
      runtime: "hermes",
      capabilities: { memory: false, reminders: false },
      model: { connectionId: accountIdOf(login) },
    },
  ];
  const assistants = {
    store: { listAssistants: () => agents },
    userActive: () => true,
    accounts: { heldImageLogin: () => login },
  };
  const access = proxyAccess({
    assistants,
    servers: { bindingsByTarget: () => ({}) },
    accountIdOf,
  });
  assert.equal(access.chatgpt("h-a", login, { images: true }), true);
  // The Responses route stays the model's own; another login is refused.
  assert.equal(access.chatgpt("h-a", login), false);
  assert.equal(access.chatgpt("h-a", other, { images: true }), false);
  // Its model's login without Create images: chat yes, images no.
  assert.equal(access.chatgpt("h-b", login), true);
  assert.equal(access.chatgpt("h-b", login, { images: true }), false);
  agents[0].archivedAt = "2026-11-02T00:00:00.000Z";
  assert.equal(access.chatgpt("h-a", login, { images: true }), false);
});

function guardBridge(t, policy = { allow: true }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-image-guard-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const supervisor = {};
  attachHermesFleet(supervisor, new HermesFleet({ dataDir }));
  const agent = { id: "m1", runtime: "hermes", runtimeAgentId: "ap-m1" };
  const checks = [];
  const bridge = {
    assistants: {
      runtime: supervisor,
      imagePolicy: {
        check: (input) => {
          checks.push(input);
          return policy;
        },
      },
    },
    agentOf: (id) => (id === "ap-m1" ? agent : null),
    attachmentPolicy: () => ({ allow: false }),
  };
  const own = path.join(dataDir, "assistants", "workspaces", "m1");
  fs.mkdirSync(own, { recursive: true });
  return { bridge, checks, own };
}
const imageCall = (args) => ({
  agentId: "ap-m1",
  sessionKey: "agent:ap-m1:hermes:s1",
  toolName: "image_generate",
  args,
});

test("image_generate asks the image policy; references stay in the agent's folder", async (t) => {
  const { bridge, checks, own } = guardBridge(t);
  fs.writeFileSync(path.join(own, "cat.png"), "png");
  assert.deepEqual(await hermesGuard(bridge, imageCall({ prompt: "a cat" })), {
    allow: true,
  });
  assert.deepEqual(
    await hermesGuard(
      bridge,
      imageCall({
        prompt: "edit",
        image_url: path.join(own, "cat.png"),
        reference_image_urls: [
          "https://example.test/style.png",
          "data:image/png;base64,AA",
        ],
      }),
    ),
    { allow: true },
  );
  assert.deepEqual(
    checks.map((input) => input.remote),
    [false, true],
  );
  assert.equal(checks[0].agentId, "ap-m1");
  for (const image_url of [
    "/etc/hosts",
    "cat.png",
    path.join(own, "..", "m2", "x.png"),
  ]) {
    const answer = await hermesGuard(bridge, imageCall({ prompt: "x", image_url }));
    assert.equal(answer.allow, false, image_url);
    assert.match(answer.message, /absolute paths to files in your work folder/);
  }
  // A link out of the folder counts by its target.
  fs.symlinkSync("/etc/hosts", path.join(own, "hosts.png"));
  assert.equal(
    (
      await hermesGuard(
        bridge,
        imageCall({ prompt: "x", image_url: path.join(own, "hosts.png") }),
      )
    ).allow,
    false,
  );
  assert.deepEqual(
    await hermesGuard(bridge, imageCall({ prompt: "x", reference_image_urls: "nope" })),
    { allow: false, message: imageRefusals.reference },
  );
  assert.equal(checks.length, 2, "refused references never reach the policy");
});

test("the image policy's refusal reaches the model with OpenClaw's reasons", async (t) => {
  const { bridge } = guardBridge(t, { allow: false, reason: "remote" });
  assert.deepEqual(
    await hermesGuard(
      bridge,
      imageCall({ prompt: "x", image_url: "https://example.test/a.png" }),
    ),
    { allow: false, message: imageRefusals.remote },
  );
});

test("the settings offer images to a Hermes agent only with a login AgentPier holds", () => {
  const hermes = { runtimeInfo: { id: "hermes" } };
  const openclaw = { runtimeInfo: { id: "openclaw" } };
  const held = { providerId: "openai-chatgpt", holder: "agentpier", signedIn: true };
  const kept = { providerId: "openai-chatgpt", holder: "openclaw", signedIn: true };
  const out = { ...held, signedIn: false };
  assert.equal(imagesFor([held], hermes), "ready");
  assert.equal(imagesFor([kept], hermes), "move");
  assert.equal(imagesFor([out], hermes), "none");
  assert.equal(imagesFor([kept], openclaw), "ready");
  assert.equal(imagesFor([], openclaw), "none");
});
