import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { PipelineDefinitions } from "../../server/features/pipelines/pipeline-definitions.js";

for (const providerId of ["openrouter", "zai", "zai-coding-plan"])
  for (const tool of ["codex", "claude", "opencode"])
    test(`${providerId}/${tool} profiles validate central access and freeze source and provider identity`, (t) => {
      const dataDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "agentpier-central-profile-"),
      );
      t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
      const connections = new ProviderConnections({ dataDir });
      const accounts = new AccountStore({
        dataDir,
        home: dataDir,
        providerConnections: connections,
      });
      const definitions = new PipelineDefinitions({ dataDir, accounts });
      const connection = connections.create({
        name: "Fixture",
        providerId,
        apiKey: "synthetic-profile-key",
        ...(providerId !== "openrouter" ? { responsesAccess: true } : {}),
      });
      const modelId = accounts.providerCatalog.list({ providerId, tool })[0].modelId;
      const input = {
        name: "Central profile",
        enabled: true,
        config: {
          accountId: `local-${tool}`,
          cliTool: tool,
          providerConnectionId: connection.id,
          models: { available: [modelId], default: modelId },
          prompts: { role: "", kickoff: "Perform task", params: [] },
          permissions: { mode: tool === "codex" ? "never" : "auto" },
          run: { autonomous: true },
        },
      };
      const saved = definitions.saveProfile(input);
      assert.equal(saved.config.providerConnectionId, connection.id);
      const pipeline = definitions.savePipeline({
        name: "Central pipeline",
        graph: {
          entry: "work",
          nodes: [{ id: "work", kind: "profile", profileId: saved.id }],
          edges: [],
        },
      });
      const frozen = definitions.snapshot(pipeline.id).profiles[saved.id];
      assert.deepEqual(frozen.accountSnapshot, {
        id: `local-${tool}`,
        tool,
        kind: "local",
      });
      assert.deepEqual(frozen.providerConnectionSnapshot, {
        id: connection.id,
        providerId,
        ...(tool === "codex" && providerId !== "openrouter"
          ? { responsesAccess: true }
          : {}),
      });
      assert.equal(
        accounts.accounts.length,
        0,
        "saving/snapshotting must not create native credential profiles",
      );
      assert.equal(JSON.stringify(frozen).includes("synthetic-profile-key"), false);
      const config = input.config;
      assert.throws(
        () =>
          definitions.saveProfile({
            ...input,
            config: { ...config, cliTool: tool === "codex" ? "claude" : "codex" },
          }),
        /match/i,
      );
      assert.throws(
        () =>
          definitions.saveProfile({
            ...input,
            config: { ...config, providerConnectionId: "missing" },
          }),
        /connection/i,
      );
      assert.throws(
        () =>
          definitions.saveProfile({
            ...input,
            config: {
              ...config,
              models: { available: [modelId, "invalid-model"], default: modelId },
            },
          }),
        /model/i,
      );
      assert.throws(
        () =>
          definitions.saveProfile({
            ...input,
            config: { ...config, models: { available: [""], default: "" } },
          }),
        /model/i,
      );
      connections.update(connection.id, {
        name: "Rotated",
        apiKey: "synthetic-rotated-key",
      });
      assert.deepEqual(
        definitions.snapshot(pipeline.id).profiles[saved.id].providerConnectionSnapshot,
        frozen.providerConnectionSnapshot,
      );
      const replacement = connections.create({
        name: "Replacement",
        providerId,
        ...(providerId !== "openrouter" ? { responsesAccess: true } : {}),
      });
      definitions.saveProfile(
        {
          ...saved,
          expectedRevision: saved.revision,
          config: { ...config, providerConnectionId: replacement.id },
        },
        saved.id,
      );
      assert.equal(frozen.config.providerConnectionId, connection.id);
      assert.equal(
        new PipelineDefinitions({ dataDir, accounts }).getProfile(saved.id).config
          .providerConnectionId,
        replacement.id,
      );
      if (tool === "codex" && providerId !== "openrouter") {
        connections.update(replacement.id, { responsesAccess: false });
        assert.throws(() => definitions.snapshot(pipeline.id), /support|Responses/i);
      }
      connections.remove(replacement.id);
      assert.throws(() => definitions.snapshot(pipeline.id), /connection/i);
    });
