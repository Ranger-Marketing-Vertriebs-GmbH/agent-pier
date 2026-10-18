import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  imageCall,
  imageRefusals,
} from "../../server/features/assistants/team-plugin/tool-guard.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { ImagePolicy } from "../../server/features/assistants/image-policy.js";

// A bridge that answers like AgentPier and records what the hook asked.
function bridge(answer = { allow: true }) {
  const asked = [];
  const call = async (endpoint, body) => {
    asked.push({ endpoint, body });
    return { ok: true, json: async () => answer };
  };
  return Object.assign(call, { asked });
}
const ctx = { agentId: "ap-a1", sessionKey: "agent:ap-a1:dashboard:x" };

test("a reference from a web address is refused unless the agent may read web pages", async () => {
  const allowed = bridge();
  const event = (params) => ({ toolName: "image_generate", params });
  assert.equal(await imageCall(event({ prompt: "a cat" }), ctx, allowed), undefined);
  assert.equal(allowed.asked[0].endpoint, "/image-policy");
  assert.deepEqual(allowed.asked[0].body, {
    agentId: "ap-a1",
    sessionKey: ctx.sessionKey,
    action: "generate",
    remote: false,
  });
  // Workspace paths and inline data stay local.
  await imageCall(
    event({ prompt: "x", image: "photos/cat.png", images: ["data:image/png;base64,AA"] }),
    ctx,
    allowed,
  );
  assert.equal(allowed.asked[1].body.remote, false);
  for (const params of [
    { prompt: "x", image: "https://example.com/a.png" },
    { prompt: "x", images: ["photos/a.png", "HTTP://example.com/b.png"] },
    { prompt: "x", image: "file:///etc/passwd" },
  ]) {
    await imageCall(event(params), ctx, allowed);
    assert.equal(allowed.asked.at(-1).body.remote, true, JSON.stringify(params));
  }
  const refused = bridge({ allow: false, reason: "remote" });
  assert.deepEqual(
    await imageCall(
      event({ prompt: "x", image: "https://example.com/a.png" }),
      ctx,
      refused,
    ),
    { block: true, blockReason: imageRefusals.remote },
  );
});

test("only OpenAI image models, well-formed references and a reachable AgentPier pass", async () => {
  const allowed = bridge();
  const event = (params) => ({ toolName: "image_generate", params });
  for (const model of ["openai/gpt-image-2", "openai/gpt-image-1.5"])
    assert.equal(await imageCall(event({ prompt: "x", model }), ctx, allowed), undefined);
  for (const model of ["fal/fal-ai/flux/dev", "openrouter/x", "", 3])
    assert.deepEqual(await imageCall(event({ prompt: "x", model }), ctx, allowed), {
      block: true,
      blockReason: imageRefusals.model,
    });
  assert.equal(
    (await imageCall(event({ prompt: "x", images: [{ url: "x" }] }), ctx, allowed)).block,
    true,
  );
  const down = async () => {
    throw Error("down");
  };
  assert.deepEqual(await imageCall(event({ prompt: "x" }), ctx, down), {
    block: true,
    blockReason: imageRefusals.unavailable,
  });
  // status and list reach the policy as such: they create nothing.
  await imageCall(event({ action: "status" }), ctx, allowed);
  assert.equal(allowed.asked.at(-1).body.action, "status");
});

function policy(t, capabilities) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-policy-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const agent = store.createAssistant({
    name: "Artist",
    model: { connectionId: "c", modelId: "m" },
  });
  store.updateAssistant(
    agent.id,
    { capabilities: { memory: false, reminders: false, ...capabilities } },
    1,
  );
  const audit = [];
  const images = new ImagePolicy({
    assistants: { store, audit: { append: (event) => audit.push(event) } },
  });
  const ask = (input = {}) =>
    images.check({
      agentId: agent.runtimeAgentId,
      sessionKey: "agent:x:dashboard:y",
      action: "generate",
      remote: false,
      ...input,
    });
  return { images, ask, audit, agent, store };
}

test("generations have no daily limit and each is audited without its prompt", (t) => {
  const f = policy(t, { createImages: true });
  for (let n = 0; n < 40; n++) assert.deepEqual(f.ask(), { allow: true });
  // Status reads are not audited as generations.
  assert.deepEqual(f.ask({ action: "status" }), { allow: true });
  assert.equal(f.audit.length, 40);
  assert.deepEqual(f.audit.at(-1).details, { kind: "image-generation" });
  assert.equal(JSON.stringify(f.audit).includes("prompt"), false);
  assert.equal("limit" in imageRefusals, false);
});

test("the capability, web reading for remote references and a known agent are required", (t) => {
  const off = policy(t, { createImages: false });
  assert.deepEqual(off.ask(), { allow: false, reason: "notGranted" });
  const local = policy(t, { createImages: true });
  assert.deepEqual(local.ask({ remote: true }), { allow: false, reason: "remote" });
  const web = policy(t, { createImages: true, webFetch: true });
  assert.deepEqual(web.ask({ remote: true }), { allow: true });
  assert.deepEqual(local.ask({ agentId: "ap-unknown" }), {
    allow: false,
    reason: "unavailable",
  });
  assert.deepEqual(local.ask({ extra: 1 }), { allow: false, reason: "unavailable" });
});
