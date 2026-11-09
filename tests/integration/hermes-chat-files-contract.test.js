import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import { eventually } from "../helpers/hermes-fake-runtime.js";
import { hermesSkip, strayAfterStop } from "../helpers/hermes-native.js";
import { hermesFleetApp, json } from "../helpers/hermes-app.js";
import {
  homeRefusal,
  splitSearchRefusal,
} from "../../server/features/assistants/hermes-home-guard.js";
import { agentPath } from "../../server/features/assistants/agent-attachment-notes.js";

// Chat files on the pinned Hermes (AGENTPIER_HERMES_CONTRACT_RUNTIME). An agent shared
// with users keeps each chat's uploads in that chat's own folder
// (chat-file-folders.js): another chat's search_files over the work folder finds
// nothing of them, also through Hermes's zero-match probe (`--hidden --no-ignore`),
// and its guard refuses a search of the chat folders, while the chat the file came
// in reads it at the path its note names. And a hook run without its Secrets switch
// cannot count matches in the secrets file with a search of the work folder. As one
// user's own agent it reads all of its own chats' files but no other agent's work
// folder and not its Hermes home. The
// in-repo fake model drives every tool call.
const options = { skip: hermesSkip, timeout: contractTimeout(1500000) };

test(
  "Hermes contract: a shared agent's chats never reach each other's files, and a hook run no secrets",
  options,
  async (t) => {
    const model = await startFakeModel();
    t.after(() => model.close());
    const app = await hermesFleetApp(t, model);
    const { assistants, fleet, f } = app;
    // Memory gives a Hermes agent without a shell its file tools (hermes-config/tools.js);
    // reminders let it take hooks.
    const created = await app.createAgent({
      name: "Hermes shared",
      shell: "off",
      capabilities: { memory: true, reminders: true },
    });
    const home = fleet.sets.get(created.runtimeAgentId).supervisor.agentPaths();

    // The agent becomes shared with users; each chat is one person's.
    const current = assistants.store.getAssistant(created.id);
    assistants.store.setUserAccess(
      created.id,
      {
        mode: "shared",
        members: [{ userId: "user-a", level: "extended" }],
        released: [],
      },
      current.revision,
    );
    await assistants.config.apply(created.id);
    await app.ready(created);
    const { sessions } = fleet.runtimeOf(created);
    const chat = async (name) => {
      const { key } = await sessions.create({
        agentId: created.runtimeAgentId,
        label: name,
        idempotencyKey: `chat-${name}`,
      });
      return assistants.store.saveConversation({
        assistantId: created.id,
        runtimeSessionKey: key,
        userId: "user-a",
      });
    };
    const turn = async (conversation, message) => {
      const runId = `turn-${randomUUID()}`;
      // The agent's runtime as it runs now (an apply may start it again).
      const { sessions } = fleet.runtimeOf(created);
      await sessions.send({
        key: conversation.runtimeSessionKey,
        turn: { message },
        idempotencyKey: runId,
      });
      await eventually(
        async () => (await sessions.wait({ runId, waitMs: 1000 })).status !== "timeout",
        120000,
        `the turn ${message}`,
      );
      const history = await sessions.history({
        sessionKey: conversation.runtimeSessionKey,
        limit: 4,
      });
      return history.messages.filter((m) => m.role === "assistant").at(-1)?.text || "";
    };
    const a = await chat("a");
    const b = await chat("b");

    // Chat A's upload lies in its own folder, outside the work folder.
    const token = `TOKEN${randomUUID().replaceAll("-", "")}`;
    const upload = await assistants.attachments.stage(
      a.id,
      "notes.md",
      Buffer.from(`# Notes\n${token}\n`),
    );
    const [row] = assistants.attachments.rows(
      "SELECT * FROM agent_attachments WHERE id=?",
      upload.id,
    );
    const file = agentPath(assistants.attachments, row);
    assert.ok(path.isAbsolute(file));
    assert.equal(file.startsWith(home.workspace + path.sep), false);
    assert.ok(fs.existsSync(file));

    // Chat B searches its work folder for the content and for the name: nothing.
    const content = await turn(
      b,
      `CALL: search_files ${JSON.stringify({ pattern: token })}`,
    );
    assert.match(content, /^TOOL_DONE: /);
    assert.equal(content.includes("notes.md"), false, content);
    assert.equal(content.includes(token.slice(5, 15)), false, content);
    const names = await turn(
      b,
      `CALL: search_files ${JSON.stringify({ pattern: "*notes*", target: "files" })}`,
    );
    assert.match(names, /^TOOL_DONE: /);
    assert.equal(names.includes("notes.md"), false, names);
    // A search of the chat folders, or a read of chat A's file, is refused, and so is
    // a path Hermes would split into several (Python also splits at \x1f).
    for (const [args, refusal] of [
      [{ pattern: token, path: path.dirname(path.dirname(file)) }, homeRefusal],
      [{ pattern: token, path: `docs ${path.dirname(file)}` }, splitSearchRefusal],
      [{ pattern: token, path: `x\u001f${path.dirname(file)}` }, splitSearchRefusal],
    ]) {
      const refused = await turn(b, `CALL: search_files ${JSON.stringify(args)}`);
      assert.ok(refused.includes(refusal.slice(0, 40)), refused);
      assert.equal(refused.includes("notes.md"), false, refused);
    }
    const read = await turn(b, `CALL: read_file ${JSON.stringify({ path: file })}`);
    assert.ok(read.includes(homeRefusal.slice(0, 40)), read);
    // Chat A reads its own file at the path its note names.
    const own = await turn(a, `CALL: read_file ${JSON.stringify({ path: file })}`);
    assert.ok(own.includes(token), own);

    // As one user's own agent it reads every chat of its own, never another agent's
    // work folder or its Hermes home (AGENTPIER-367).
    const sharedAgent = assistants.store.getAssistant(created.id);
    assistants.store.setUserAccess(
      created.id,
      { mode: "own", members: [{ userId: "user-a", level: "extended" }], released: [] },
      sharedAgent.revision,
    );
    await assistants.config.apply(created.id);
    await app.ready(created);
    const neighbour = path.join(path.dirname(home.workspace), "neighbour", "secret.md");
    fs.mkdirSync(path.dirname(neighbour), { recursive: true });
    fs.writeFileSync(neighbour, `${token}\n`);
    for (const target of [neighbour, path.join(home.hermesHome, "config.yaml")]) {
      const refused = await turn(
        b,
        `CALL: read_file ${JSON.stringify({ path: target })}`,
      );
      assert.ok(refused.includes(homeRefusal.slice(0, 40)), refused);
      assert.equal(refused.includes(token), false, refused);
    }
    const neighbours = await turn(
      b,
      `CALL: search_files ${JSON.stringify({ pattern: token, path: path.dirname(neighbour) })}`,
    );
    assert.ok(neighbours.includes(homeRefusal.slice(0, 40)), neighbours);
    const earlier = await turn(b, `CALL: read_file ${JSON.stringify({ path: file })}`);
    assert.ok(earlier.includes(token), earlier);

    // Back to the owner's own agent: a hook without Secrets searches its work folder.
    const owner = assistants.store.getAssistant(created.id);
    assistants.store.setUserAccess(created.id, null, owner.revision);
    await assistants.config.apply(created.id);
    await app.ready(created);
    // The secrets file as AgentPier delivers it; nothing re-syncs it in this test.
    f.application.assistantAgentSecrets?.close?.();
    const secret = `sk-contract-${randomUUID()}`;
    const secretsFile = path.join(home.workspace, ".agentpier", "secrets.env");
    fs.mkdirSync(path.dirname(secretsFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(secretsFile, `CONTRACT_KEY='${secret}'\n`, { mode: 0o600 });
    // The owner's chat searches it (with ripgrep on the agent's PATH, Hermes's probe
    // even names the hidden file for a regex that finds nothing visible).
    const ownerChat = await app.chat(created);
    const probe = { pattern: "sk-contract-[0-9a-f]{8}-" };
    await ownerChat.send("probe", `CALL: search_files ${JSON.stringify(probe)}`);
    const found = await ownerChat.reply("TOOL_DONE");
    assert.equal(found.text.includes("secrets are not available"), false, found.text);

    const base = `/api/assistants/${created.id}/hooks`;
    const { hook } = await json(
      await f.request(base, {
        method: "POST",
        body: {
          name: "Probe",
          sender: "CI",
          instruction: `CALL: search_files ${JSON.stringify(probe)}`,
          rights: { notify: false },
        },
      }),
      201,
    );
    await json(await f.request(`${base}/${hook.id}/test`, { method: "POST" }), 202);
    const hooks = f.application.assistantRoutines.hooks;
    let event = null;
    await eventually(
      () => {
        event = hooks.events.last(hook.id);
        return event && !["pending", "running"].includes(event.status);
      },
      300000,
      "the hook event settled",
    );
    assert.equal(event.secretsRead, false);
    assert.match(event.reply, /^TOOL_DONE: /);
    assert.match(event.reply, /secrets are not available/);
    assert.equal(event.reply.includes("secrets.env"), false, event.reply);
    assert.equal(event.reply.includes(secret), false, event.reply);

    await fleet.close();
    assert.deepEqual(await strayAfterStop({ root: home.hermesHome }), []);
  },
);
