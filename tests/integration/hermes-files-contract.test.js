import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import {
  collectEvents,
  contractAgent,
  endsRun,
  hermesSandbox,
  hermesSkip,
  startHermes,
  strayAfterStop,
} from "../helpers/hermes-native.js";
import {
  endStdioServers,
  stdioMcpScript,
  stdioRecords,
} from "../helpers/mcp-test-servers.js";

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
      files.set({ agentId, name: "USER.md", content: "x".repeat(5001) }),
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

test(
  "Hermes contract: assigned skills reach the agent, the others stay off, its own show up",
  options,
  async (t) => {
    const { dirs, model } = await sandbox(t);
    const hermes = await startHermes(t, dirs, { agentId, model });
    const { runtime, stop } = hermes;
    // A catalog skill in its live folder, as the skill catalog keeps it.
    const folder = path.join(dirs.root, "skill-catalog", "skills", "quartz-notes");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, "SKILL.md"),
      "---\nname: quartz-notes\ndescription: Keep notes in the quartz vault\n---\n\n" +
        "# Quartz notes\n\nAlways start with QUARTZ-MARKER-42.\n",
    );
    const skills = ["quartz-notes", "test-driven-development"];
    const applied = await runtime.config.apply({
      desired: contractAgent(agentId, model, { skills }),
      catalog: { "quartz-notes": folder },
    });
    assert.equal(applied.restarted, true);
    assert.ok(applied.written.includes("config.yaml"));
    const { skills: report } = await runtime.skills.status({ agentId });
    const byName = Object.fromEntries(report.map((s) => [s.name, s]));
    assert.equal(byName["quartz-notes"].origin, "catalog");
    assert.equal(byName["quartz-notes"].blockedByAgentFilter, false);
    assert.equal(byName["test-driven-development"].origin, "bundled");
    assert.equal(byName["test-driven-development"].blockedByAgentFilter, false);
    assert.equal(byName["systematic-debugging"].blockedByAgentFilter, true);
    // The agent reads the catalog skill.
    const view = await turn(
      hermes,
      `CALL: skill_view {"name":"quartz-notes"}`,
      "skill-1",
    );
    assert.equal(view.kind, "finished");
    const toolResults = model.requests.flatMap(({ body }) =>
      (body.messages || [])
        .filter((m) => m.role === "tool")
        .map((m) => String(m.content)),
    );
    assert.ok(
      toolResults.some((content) => content.includes("QUARTZ-MARKER-42")),
      "skill_view returned the catalog skill",
    );
    // Its skill index names what is on and leaves out what is off.
    const prompt = systemPrompts(model).find((text) => text.includes("quartz-notes"));
    assert.ok(prompt, "the skill index names the catalog skill");
    assert.ok(prompt.includes("test-driven-development"));
    assert.ok(!prompt.includes("systematic-debugging"));
    // A skill the agent writes itself stays on and is reported as its own.
    const create = JSON.stringify({
      operations: [
        {
          action: "create",
          name: "owner-notes",
          content:
            "---\nname: owner-notes\ndescription: Notes about the owner\n---\n\n# Notes\n",
        },
      ],
    });
    const wrote = await turn(hermes, `CALL: skill_manage ${create}`, "skill-2");
    assert.equal(wrote.kind, "finished");
    const after = (await runtime.skills.status({ agentId })).skills;
    const own = after.find((s) => s.name === "owner-notes");
    assert.equal(own?.origin, "local");
    assert.equal(own.blockedByAgentFilter, false);
    await stop();
    assert.deepEqual(await strayAfterStop(dirs), []);
  },
);

test(
  "Hermes contract: a bound stdio MCP server's tool is callable, its secret stays out of the shell",
  options,
  async (t) => {
    const { dirs, model } = await sandbox(t);
    const hermes = await startHermes(t, dirs, { agentId, model });
    const { runtime, agent, stop } = hermes;
    const records = path.join(dirs.root, "mcp-calls.jsonl");
    t.after(() => endStdioServers(records));
    const secret = "hermes-mcp-secret-7";
    const mcp = {
      servers: [
        {
          id: "s1",
          name: "fixture",
          transport: "stdio",
          command: process.execPath,
          args: [stdioMcpScript, records],
        },
      ],
      secrets: { s1: { env: { MCP_FIXTURE_SECRET: secret }, headers: {} } },
    };
    const applied = await runtime.config.apply({
      desired: contractAgent(agentId, model, {}, { mcp: ["s1"] }),
      mcp,
    });
    assert.equal(applied.restarted, true);
    // The secret is in .env only; config.yaml names it by reference.
    const config = fs.readFileSync(path.join(agent.hermesHome, "config.yaml"), "utf8");
    assert.ok(!config.includes(secret));
    assert.match(config, /MCP_FIXTURE_SECRET: \$\{AUXILIARY_AGENTPIER_MCP1_E1_API_KEY\}/);
    // Hermes names the tool mcp__<server>__<tool> and offers MCP tools through its
    // tool search bridge, which lists it; the agent calls it through tool_call.
    const listed = (body) =>
      (body.tools || []).some(
        (tool) =>
          tool.function?.name === "tool_search" &&
          JSON.stringify(tool).includes("mcp__fixture__echo"),
      );
    const call = JSON.stringify({
      calls: [{ name: "mcp__fixture__echo", arguments: { text: "quartz" } }],
    });
    const end = await turn(hermes, `CALL: tool_call ${call}`, "mcp-1");
    assert.equal(end.kind, "finished");
    assert.match(end.payload.text, /echo:quartz/);
    assert.ok(
      model.requests.some(({ body }) => listed(body)),
      "the tool search lists the server's tool",
    );
    const calls = stdioRecords(records);
    assert.ok(calls.some((entry) => entry.tool === "echo" && entry.text === "quartz"));
    // The server got its secret; the agent's own shell does not see it.
    assert.ok(
      calls.some(
        (entry) => entry.event === "start" && entry.env.MCP_FIXTURE_SECRET === "set",
      ),
    );
    const shell = await turn(hermes, "RUN: env", "mcp-2");
    assert.equal(shell.kind, "finished");
    const results = model.requests.flatMap(({ body }) =>
      (body.messages || [])
        .filter((m) => m.role === "tool")
        .map((m) => String(m.content)),
    );
    assert.ok(
      results.some((content) => content.includes("HERMES_HOME")),
      "env ran",
    );
    assert.ok(!results.some((content) => content.includes(secret)));
    assert.ok(!results.some((content) => content.includes("AUXILIARY_AGENTPIER_MCP")));
    await stop();
    assert.deepEqual(await strayAfterStop(dirs), []);
  },
);
