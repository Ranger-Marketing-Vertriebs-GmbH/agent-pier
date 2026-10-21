import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { run, shareFixture } from "../helpers/agent-share-fixture.js";
import {
  attachmentCall,
  attachmentRefusal,
} from "../../server/features/assistants/team-plugin/tool-guard.js";

// The fixture's agent shared by Anna (its chat) and Ben (a second chat), each with
// one upload in the agent's common attachments/ folder.
async function sharedAgent(t, mode = "shared") {
  const f = await shareFixture(t);
  const body = {
    ...f.store.storedAssistant(f.agent.id),
    userAccess: {
      mode,
      members: [
        { userId: "anna", level: "chat" },
        ...(mode === "shared" ? [{ userId: "ben", level: "chat" }] : []),
      ],
      released: [],
    },
  };
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), f.agent.id);
  const agent = f.store.getAssistant(f.agent.id);
  const ben = f.store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: "ben",
  });
  const upload = (conversation, file) => {
    f.file(agent, `attachments/${file}`, "%PDF-1.4 private");
    f.store.db
      .prepare(
        "INSERT INTO agent_attachments (id,assistant_id,conversation_id,request_id,body,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(file, agent.id, conversation.id, null, JSON.stringify({ file }), Date.now());
  };
  upload(f.chat, "20261021-aaaa-anna.pdf");
  upload(ben, "20261021-bbbb-passport.pdf");
  const bridge = (endpoint, body) =>
    fetch(f.connection.url + endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.connection.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const roots = [f.workspaces];
  const call = (conversation, toolName, params) =>
    attachmentCall(
      { toolName, params },
      { agentId: agent.runtimeAgentId, sessionKey: conversation.runtimeSessionKey },
      bridge,
      roots,
    );
  return { ...f, agent, ben, call };
}

const blocked = { block: true, blockReason: attachmentRefusal };

test("a turn on a shared agent reads only its own chat's uploads", async (t) => {
  const f = await sharedAgent(t);
  await f.turn(f.chat, "anna-turn", { kind: "user", userId: "anna" });
  const own = "attachments/20261021-aaaa-anna.pdf",
    hers = "attachments/20261021-bbbb-passport.pdf";
  assert.equal(await f.call(f.chat, "read", { path: own }), undefined);
  assert.equal(await f.call(f.chat, "pdf", { pdf: own }), undefined);
  assert.equal(await f.call(f.chat, "read", { path: "notes.md" }), undefined);
  for (const [tool, params] of [
    ["read", { path: hers }],
    ["read", { file_path: `./${hers}` }],
    ["read", { path: "ATTACHMENTS/20261021-bbbb-passport.pdf" }],
    ["read", { path: path.join(f.workspaces, f.agent.id, hers) }],
    ["read", { path: "memory/../attachments/20261021-bbbb-passport.pdf" }],
    ["read", { path: "attachments" }],
    ["pdf", { pdfs: [own, hers] }],
    ["image", { image: hers }],
    ["write", { path: hers, content: "x" }],
  ])
    assert.deepEqual(await f.call(f.chat, tool, params), blocked, JSON.stringify(params));
  // Sharing her file into this chat is refused as well.
  await assert.rejects(
    run(f.tool(f.agent, f.chat), { path: hers }),
    /^Error: SHARE_NOT_FOUND: /,
  );
  const shared = await run(f.tool(f.agent, f.chat), { path: own });
  assert.equal(shared.status, "shared");
});

test("an agent that is not shared keeps reading its whole attachments folder", async (t) => {
  const f = await sharedAgent(t, "own");
  assert.equal(
    await f.call(f.chat, "read", { path: "attachments/20261021-bbbb-passport.pdf" }),
    undefined,
  );
  assert.ok(fs.existsSync(path.join(f.workspaces, f.agent.id, "attachments")));
});
