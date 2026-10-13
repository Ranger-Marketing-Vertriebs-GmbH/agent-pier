import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { runtimeEnvironment } from "../../server/features/assistants/runtime-config.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { AssistantModelAccounts } from "../../server/features/assistants/model-accounts.js";
import {
  accountModelId,
  parseModelsList,
} from "../../server/features/assistants/model-account-catalog.js";
import { locateOpenClawExports } from "../helpers/openclaw-dist-exports.js";

// Synthetic OAuth credentials only: the pinned Gateway rejects them, so this
// contract proves the request and the row shape, not a signed-in model list.
const installed = process.env.AGENTPIER_ASSISTANT_PROVIDER_RUNTIME;
const profileId = "openai:models-contract";
const reasons = ["missing-auth", "auth-failed", "cooldown"];

test(
  "the pinned Gateway answers the ChatGPT model list read in the shape AgentPier parses",
  { skip: !installed, timeout: 240000 },
  async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-models-contract-"));
    const nodePath = path.join(installed, "node/bin/node");
    const app = path.join(installed, "app/node_modules/openclaw");
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8")).version,
      runtimeManifest.version,
    );
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => ({
        version: runtimeManifest.version,
        nodePath,
        entryPath: path.join(app, "openclaw.mjs"),
      }),
    });
    t.after(async () => {
      await runtime.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });
    await runtime.start();
    await runtime.stop();
    // Version-pinned native writer, isolated HOME/state, never real credentials.
    const writer = locateOpenClawExports(app, ["upsertAuthProfile"]).upsertAuthProfile;
    const code = `import {${writer.alias} as upsert} from ${JSON.stringify(writer.path)};
      upsert({ profileId: ${JSON.stringify(profileId)}, credential: {type:'oauth',
        provider:'openai', access:'SYNTHETIC_ACCESS', refresh:'SYNTHETIC_REFRESH',
        expires:Date.now()+86400000, email:'synthetic@example.invalid'} });`;
    execFileSync(nodePath, ["--input-type=module", "-e", code], {
      env: runtimeEnvironment(runtime.paths, nodePath),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    await runtime.start();
    const client = runtime.client;

    // `authProfileId` scopes the list to personal user accounts of an authenticated
    // Gateway user; the agent's own OAuth profiles are refused for an operator.
    await assert.rejects(
      client.call("models.list", { agentId: "main", authProfileId: profileId }),
      { code: "FORBIDDEN" },
    );

    const accounts = new AssistantModelAccounts({ dataDir, runtime });
    const [account] = await accounts.list();
    assert.equal(
      account.id,
      `openclaw:${createHash("sha256").update(profileId).digest("hex")}`,
    );
    // The exact read the catalog sends, including its follow-up while discovery runs.
    const result = await accounts.refreshModels(account.id);
    t.diagnostic(`refreshModels=${JSON.stringify(result)}`);
    const calls = [];
    const call = client.call.bind(client);
    client.call = (method, params, ...rest) => {
      if (method === "models.list") calls.push(params);
      return call(method, params, ...rest);
    };
    await accounts.catalog.refresh();
    client.call = call;
    assert.deepEqual(calls[0], { agentId: "main", provider: "openai", view: "all" });
    // Synthetic tokens: the Gateway reports this profile's outcome, so the account
    // shows the hint and free text instead of a list.
    assert.deepEqual(accounts.catalog.account(profileId), {
      models: [],
      modelCatalog: "failed",
    });
    // The read itself succeeded and parsed: only this profile's outcome failed.
    assert.equal(accounts.catalog.account("openai:other").modelCatalog, "ready");

    const raw = await client.call(
      "models.list",
      { agentId: "main", provider: "openai", view: "all" },
      { timeoutMs: 60000 },
    );
    assert.deepEqual(
      raw.providerOutcomes?.find((o) => o.profileId === profileId),
      { provider: "openai", profileId, status: "auth-rejected" },
    );
    assert.ok(raw.models.length > 0, "the openai catalog lists its models");
    for (const row of raw.models) {
      assert.equal(row.provider, "openai");
      assert.equal(typeof row.id, "string");
      assert.equal(typeof row.name, "string");
      assert.equal(typeof row.available, "boolean");
      if (!row.available) assert.ok(reasons.includes(row.unavailableReason));
    }
    // Every catalog row is a bare ID that resolve() pins to this exact profile.
    const usable = parseModelsList({
      models: raw.models.map((row) => ({ ...row, available: true })),
    });
    assert.equal(usable.models.length, raw.models.length);
    for (const { modelId, label } of usable.models) {
      assert.match(modelId, accountModelId);
      assert.ok(label);
      assert.equal(
        accounts.offlineSelection(account.id, modelId).modelRef,
        `openai/${modelId}@${profileId}`,
      );
    }
  },
);
