import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import {
  collectEvents,
  endsRun,
  hermesSandbox,
  hermesSkip,
  startHermes,
  strayAfterStop,
} from "../helpers/hermes-native.js";

// The agent's files, skills and MCP servers as the pinned Hermes runs them through
// AgentPier's Hermes runtime (hermes-native.js), with the in-repo fake model, whose
// "CALL: <tool> <arguments>" makes the agent call a tool.
const options = { skip: hermesSkip, timeout: contractTimeout(600000) };
const agentId = "hermes-agent";
const label = "AgentPier hermes-agent chat";

async function sandbox(t) {
  const model = await startFakeModel();
  t.after(() => model.close());
  return { dirs: hermesSandbox(t), model };
}

// One turn in a new session: resolves its end event; the session starts after
// whatever the test wrote before, so Hermes reads it at the session's start.
async function turn({ sessions, events }, message, runId) {
  const { key } = await sessions.create({ agentId, label, idempotencyKey: runId });
  const run = collectEvents(events);
  await sessions.send({ key, turn: { message }, idempotencyKey: runId });
  const end = await run.until(endsRun(runId), contractTimeout(240000));
  run.unsubscribe();
  return end;
}

// The system prompt of each chat call the model received.
const systemPrompts = (model) =>
  model.requests.map(({ body }) =>
    (body.messages || [])
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n"),
  );

test(
  "Hermes contract: memory written through the port reaches the agent, and its own writes come back",
  options,
  async (t) => {
    const { dirs, model } = await sandbox(t);
    const hermes = await startHermes(t, dirs, { agentId, model });
    const { runtime, agent, stop } = hermes;
    const files = runtime.agentFiles;
    // The owner's note, written over the absence AgentPier read.
    const before = await files.get({ agentId, name: "MEMORY.md" });
    await files.set({
      agentId,
      name: "MEMORY.md",
      content: "The owner's vault lives at /srv/quartz-vault",
      ...(before.file.missing
        ? { expectedMissing: true }
        : { expectedHash: before.file.hash }),
    });
    assert.ok(fs.existsSync(path.join(agent.hermesHome, "memories", "MEMORY.md")));
    // Hermes's memory tool adds an entry to USER.md in the agent's turn.
    const call = JSON.stringify({
      action: "add",
      target: "user",
      content: "Owner prefers green tea",
    });
    const end = await turn(hermes, `CALL: memory ${call}`, "memory-1");
    assert.equal(end.kind, "finished");
    assert.match(end.payload.text, /^TOOL_DONE:/);
    // The session started after the owner's write: its prompt holds the note.
    assert.ok(
      systemPrompts(model).some((prompt) => prompt.includes("/srv/quartz-vault")),
      "the owner's memory entry is in the agent's system prompt",
    );
    const user = await files.get({ agentId, name: "USER.md" });
    assert.equal(user.file.missing, false);
    assert.match(user.file.content, /Owner prefers green tea/);
    const found = await files.searchMemory({
      agentId,
      query: "green tea",
      maxResults: 5,
    });
    assert.deepEqual(
      found.output.details.results.map((r) => r.path),
      ["USER.md"],
    );
    // Hermes's limit holds for the owner too, and the file stays as it was.
    await assert.rejects(
      files.set({ agentId, name: "USER.md", content: "x".repeat(1376) }),
      (error) => error.code === "TOO_LARGE",
    );
    assert.match((await files.get({ agentId, name: "USER.md" })).file.content, /tea/);
    // SOUL.md is the compiled instructions, read through the same port.
    const soul = await files.get({ agentId, name: "SOUL.md" });
    assert.equal(soul.file.content, `# ${agentId}\n\nYou help the owner.\n`);
    await stop();
    await assert.rejects(
      files.get({ agentId, name: "MEMORY.md" }),
      (error) => error.code === "UNAVAILABLE",
    );
    assert.deepEqual(await strayAfterStop(dirs), []);
  },
);
