import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";

// The agent's secrets file is synced before each turn (agent-secrets.js), on a
// full apply and on the cached one alike, and a failed sync never fails the turn.
test("every apply delivers the agent's secrets first, and survives a failure", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-secrets-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const a = store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  const files = {};
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  const client = {
    async call(method, params) {
      if (method === "config.get")
        return {
          hash: "h",
          config: { agents: { entries: { [a.runtimeAgentId]: { model: "c/m" } } } },
        };
      if (method === "agents.list") return { agents: [{ id: a.runtimeAgentId }] };
      if (method === "agents.update") return {};
      if (method === "agents.files.get")
        return {
          file:
            params.name in files
              ? { content: files[params.name], hash: hash(files[params.name]) }
              : { missing: true },
        };
      if (method === "agents.files.set") {
        files[params.name] = params.content;
        return {};
      }
      assert.fail(method);
    },
  };
  const config = new AssistantConfig({
    client,
    store,
    workspaces: dataDir,
    models: {
      resolve: () => ({
        modelRef: "c/m",
        display: { connection: "Ollama", model: "Qwen" },
        release() {},
      }),
    },
  });
  const synced = [];
  config.syncSecrets = async (id) => synced.push(id);
  await config.apply(a.id);
  assert.deepEqual(synced, [a.id], "full apply");
  await config.apply(a.id);
  assert.deepEqual(synced, [a.id, a.id], "cached apply");
  config.syncSecrets = async () => {
    throw Object.assign(Error("unsafe"), { code: "SECRET_UNSAFE_PATH" });
  };
  await config.apply(a.id);
  assert.equal(store.getAssistant(a.id).effectiveRevision, 1);
});

// The bootstrap names the secrets file while the agent receives one; a flip of
// secretsGranted reaches AGENTS.md on the next apply (the one before each turn).
test("the bootstrap names the secrets file only while secrets are granted", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-secrets-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const a = store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  const files = {};
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  const client = {
    async call(method, params) {
      if (method === "config.get")
        return {
          hash: "h",
          config: { agents: { entries: { [a.runtimeAgentId]: { model: "c/m" } } } },
        };
      if (method === "agents.list") return { agents: [{ id: a.runtimeAgentId }] };
      if (method === "agents.update") return {};
      if (method === "agents.files.get")
        return {
          file:
            params.name in files
              ? { content: files[params.name], hash: hash(files[params.name]) }
              : { missing: true },
        };
      if (method === "agents.files.set") {
        files[params.name] = params.content;
        return {};
      }
      assert.fail(method);
    },
  };
  const config = new AssistantConfig({
    client,
    store,
    workspaces: dataDir,
    models: {
      resolve: () => ({ modelRef: "c/m", display: {}, release() {} }),
    },
  });
  let granted = false;
  config.secretsGranted = (assistant) => {
    assert.equal(assistant.id, a.id);
    return granted;
  };
  await config.apply(a.id);
  assert.doesNotMatch(files["AGENTS.md"], /secrets\.env/);
  granted = true;
  await config.apply(a.id);
  assert.match(files["AGENTS.md"], /`\.agentpier\/secrets\.env`/);
  granted = false;
  await config.apply(a.id);
  assert.doesNotMatch(files["AGENTS.md"], /secrets\.env/);
});
