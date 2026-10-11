import test from "node:test";
import assert from "node:assert/strict";
import { agentEntry } from "../../server/features/assistants/openclaw-config/agent-entry.js";

const assistant = {
  id: "a1",
  runtimeAgentId: "ap-a1",
  capabilities: { memory: true, reminders: false },
};

test("an unproven write guard keeps write and edit out of the tool list", () => {
  const entry = agentEntry({ id: "ap-a1", model: "m" }, assistant, {
    teamsReady: true,
    nativeReady: true,
    guardProven: false,
  });
  assert.ok(!entry.tools.allow.includes("write"));
  assert.ok(entry.tools.allow.includes("read"));
  assert.equal(entry.model, "m");
  assert.deepEqual(entry.memory, {
    search: { enabled: true, rememberAcrossConversations: false },
  });
});

test("a proven guard grants writes and an agent runtime is recorded", () => {
  const entry = agentEntry({ id: "ap-a1" }, assistant, {
    teamsReady: true,
    nativeReady: true,
    guardProven: true,
    agentRuntime: { model: "codex/gpt", id: "codex" },
  });
  assert.ok(entry.tools.allow.includes("write"));
  assert.deepEqual(entry.models["codex/gpt"].agentRuntime, { id: "codex" });
});

test("without native teams memory search is left untouched", () => {
  const entry = agentEntry({ id: "ap-a1" }, assistant, {
    teamsReady: true,
    nativeReady: false,
    guardProven: false,
  });
  assert.equal(entry.memory, undefined);
});

test("a wired but not yet ready Gateway still resets tools and memory", () => {
  const entry = agentEntry({ id: "ap-a1" }, assistant, {
    teamsReady: false,
    nativeReady: false,
    guardProven: false,
    toolsManaged: true,
    memoryManaged: true,
  });
  assert.deepEqual(entry.tools.allow, ["session_status"]);
  assert.deepEqual(entry.memory, {
    search: { enabled: false, rememberAcrossConversations: false },
  });
});
