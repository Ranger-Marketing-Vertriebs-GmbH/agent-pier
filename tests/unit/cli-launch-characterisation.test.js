import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AccountStore,
  cleanEnvironment,
} from "../../server/features/accounts/account-store.js";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { ProviderCatalog } from "../../server/features/providers/provider-catalog.js";
import { ProviderAccess } from "../../server/features/providers/provider-access.js";
import { statusArgs } from "../../server/features/accounts/auth-status.js";
import { resumeLaunch } from "../../server/application/session-reload-launch.js";

// Oracle for the CLI-definition refactor: launch lines and per-account
// environments recorded from the tree before any per-CLI knowledge moved.
const FIXTURE = new URL("../fixtures/cli-launch-characterisation.json", import.meta.url);
const MODES = {
  codex: ["default", "yolo"],
  claude: ["default", "auto", "bypass"],
  opencode: ["default", "auto"],
  shell: ["default"],
};
const CLI_VERSION = "2.2.0";
const SESSION_ID = "00000000-0000-4000-8000-000000000001";

function scrub(value, root) {
  return typeof value === "string"
    ? value
        .split(root)
        .join("<root>")
        .replace(/\/profiles\/[0-9a-f-]{36}\//g, "/profiles/<account>/")
    : value;
}

/** Only what AgentPier sets or changes; host-inherited variables stay out. */
function recordEnv(env, root) {
  const host = cleanEnvironment();
  const out = {};
  for (const key of Object.keys(env).sort()) {
    if (key === "PATH") continue;
    if (env[key] !== host[key]) out[key] = scrub(env[key], root);
  }
  const added = (env.PATH || "")
    .split(path.delimiter)
    .filter((dir) => dir.startsWith(root));
  out.PATH_added = added.map((dir) => scrub(dir, root));
  return out;
}

async function record(root, accounts, account, mode, login) {
  const executable =
    account.tool === "shell" ? "/bin/sh" : path.join(root, "fixture-bin", account.tool);
  const launch = await accounts.command(
    account.id,
    { [account.tool]: executable },
    login,
    mode,
    { cliVersion: CLI_VERSION },
  );
  return {
    command: scrub(launch.command, root),
    args: launch.args.map((arg) => scrub(arg, root)),
    env: recordEnv(launch.env, root),
  };
}

const model = (modelId, contextTokens) => ({
  modelId,
  label: modelId,
  contextTokens,
  outputTokens: null,
  source: "manual",
  contextEdited: true,
});
const ENDPOINT = {
  preset: "custom",
  openaiBaseUrl: "http://127.0.0.1:11434/v1",
  anthropicBaseUrl: "http://127.0.0.1:11434",
  protocols: { messages: true, responses: true, chatCompletions: true },
  authHeader: null,
  models: [model("qwen3", 32768), model("llama", 65536)],
  lastTest: null,
};

/** The Codex config AgentPier writes for a provider launch is part of the launch. */
function codexConfig(env, root) {
  return scrub(fs.readFileSync(path.join(env.CODEX_HOME, "config.toml"), "utf8"), root);
}

async function recordProviders(root, accounts, connections, catalog, result) {
  const run = async (name, account, modelId) => {
    const executable = path.join(root, "fixture-bin", account.tool);
    const launch = await accounts.command(
      account.id,
      { [account.tool]: executable },
      false,
      "default",
      {
        cliVersion: CLI_VERSION,
        ...(modelId ? { modelId } : {}),
      },
    );
    result.providers[name] = {
      command: scrub(launch.command, root),
      args: launch.args.map((arg) => scrub(arg, root)),
      env: recordEnv(launch.env, root),
      ...(launch.env.CODEX_HOME ? { codexConfig: codexConfig(launch.env, root) } : {}),
    };
  };
  const selections = {
    openrouter: { modelId: "anthropic/claude-sonnet-4.6" },
    zai: { modelId: "glm-5.3" },
    "zai-coding-plan": { modelId: "glm-5.3" },
  };
  for (const tool of ["codex", "claude", "opencode"])
    for (const [id, selection] of Object.entries(selections)) {
      const provider = {
        id,
        ...selection,
        ...(tool === "codex" && id !== "openrouter" ? { responsesAccess: true } : {}),
      };
      const account = accounts.create({
        name: `Provider ${id}`,
        tool,
        apiKey: "fixture-provider-key",
        provider,
      });
      await run(`${tool}/${id}`, account);
    }
  const access = new ProviderAccess({ accounts, connections, providerCatalog: catalog });
  const connection = connections.create({
    name: "GPU box",
    providerId: "endpoint",
    endpoint: ENDPOINT,
    apiKey: "fixture-endpoint-key",
  });
  for (const tool of ["codex", "claude", "opencode"]) {
    const account = access.resolve({
      tool,
      providerConnectionId: connection.id,
      providerModelId: "qwen3",
    }).account;
    await run(`${tool}/endpoint`, account);
    await run(`${tool}/endpoint/model-override`, account, "llama");
  }
  const plain = accounts.create({ name: "Model", tool: "codex" });
  await run("codex/managed/model-override", plain, "fixture-model");
}

async function build() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-characterisation-")),
  );
  try {
    const dataDir = path.join(root, "data");
    const providerCatalog = new ProviderCatalog({ dataDir });
    const connections = new ProviderConnections({ dataDir });
    const accounts = new AccountStore({
      dataDir,
      home: root,
      uid: () => 501,
      providerCatalog,
      providerConnections: connections,
    });
    const result = { launches: {}, providers: {}, resume: {}, apiKeyEnv: {} };
    for (const [tool, modes] of Object.entries(MODES)) {
      const kinds = { local: accounts.get(`local-${tool}`) };
      if (tool !== "shell") {
        kinds.managed = accounts.create({ name: "Fixture", tool });
        kinds["managed-api-key"] = accounts.create({
          name: "Fixture key",
          tool,
          apiKey: "fixture-key",
        });
      }
      for (const [kind, account] of Object.entries(kinds)) {
        for (const mode of modes)
          result.launches[`${tool}/${kind}/${mode}`] = await record(
            root,
            accounts,
            account,
            mode,
            false,
          );
        if (kind === "managed")
          result.launches[`${tool}/${kind}/login`] = await record(
            root,
            accounts,
            account,
            "default",
            true,
          );
      }
    }
    await recordProviders(root, accounts, connections, providerCatalog, result);
    for (const tool of ["codex", "claude", "opencode"]) {
      const launch = { command: "/bin/x", args: ["--base"], env: {} };
      result.resume[tool] = resumeLaunch(tool, launch, SESSION_ID).args;
      const keyed = accounts.create({ name: "Key env", tool, apiKey: "env-probe" });
      const env = accounts.environment(keyed.id);
      result.apiKeyEnv[tool] = Object.keys(env).filter((k) => env[k] === "env-probe");
    }
    return result;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("launch args and env per CLI and mode stay as recorded", async () => {
  const actual = await build();
  actual.authStatusArgs = statusArgs;
  if (process.env.UPDATE_FIXTURE === "1") {
    fs.writeFileSync(FIXTURE, JSON.stringify(actual, null, 2) + "\n");
    return;
  }
  assert.deepStrictEqual(actual, JSON.parse(fs.readFileSync(FIXTURE, "utf8")));
});
