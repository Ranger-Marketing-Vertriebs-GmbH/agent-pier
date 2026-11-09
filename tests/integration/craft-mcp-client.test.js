import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CraftMcpClient } from "../../server/features/craft/craft-mcp-client.js";

const fakeServer = path.resolve(import.meta.dirname, "../helpers/fake-craft-mcp.mjs");

function setup(t, { script, args = ["mcp", "--all-tools", "--allow-run"] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "agentpier-craft-mcp-"));
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const start = async () => {
    const client = await CraftMcpClient.start({
      command: process.execPath,
      args: [fakeServer, ...args],
      cwd: dir,
      env: {
        ...process.env,
        CRAFT_ANYTHING_CONFIG_DIR: path.join(dir, "config"),
        ...(script && { FAKE_CRAFT_SCRIPT: JSON.stringify(script) }),
      },
    });
    clients.push(client);
    return client;
  };
  return { dir, start };
}

const exists = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function startBuild(client, dir, name = "app") {
  const folder = path.join(dir, name);
  const { project, started } = await client.call("rebuild_start", {
    request: "Rebuild the counter",
    target: "-",
    project_folder: folder,
  });
  assert.equal(started, true);
  const record = JSON.parse(readFileSync(path.join(folder, "craft.json"), "utf8"));
  return { project, folder, builder: record.fake_builder.pid };
}

test("calls a tool and returns its result", async (t) => {
  const { dir, start } = setup(t, {
    script: {
      steps: [
        { wait: 500 },
        { ask: "question", title: "Which colour?", choices: ["Red"] },
      ],
    },
  });
  const client = await start();
  assert.equal(client.alive, true);
  const { project, folder } = await startBuild(client, dir);
  assert.ok(project);
  const status = await client.call("rebuild_status", { project });
  assert.equal(status.running, true);
  assert.equal(status.status, "building");
  assert.ok(
    await until(
      async () => (await client.call("project_show", { project })).questions[0],
    ),
  );
  const shown = await client.call("project_show", { project });
  assert.equal(shown.questions[0].kind, "question");
  assert.equal(shown.questions[0].title, "Which colour?");
  assert.deepEqual(
    await client.call("project_inbox_answer", {
      project,
      id: shown.questions[0].id,
      choice: "Red",
    }),
    { answered: true },
  );
  const { lines } = await client.call("rebuild_activity_show", { project, limit: 50 });
  assert.ok(lines.some((line) => line.includes("Red")));
  assert.ok(
    readFileSync(path.join(folder, "build-activity.log"), "utf8").includes("Red"),
  );
  JSON.parse(readFileSync(path.join(folder, "usage.json"), "utf8"));
});

test("a spawn failure surfaces its cause", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentpier-craft-mcp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(
    CraftMcpClient.start({
      command: path.join(dir, "missing-craft-anything-cli"),
      args: ["mcp"],
      cwd: dir,
      env: process.env,
    }),
    (error) => error.code === "ENOENT",
  );
});

test("resuming asks an open question again and waits for the new one", async (t) => {
  const { dir, start } = setup(t, {
    script: {
      steps: [
        { ask: "question", title: "Which colour?", choices: ["Red"] },
        { activity: "after the answer" },
      ],
    },
  });
  const client = await start();
  const { project } = await startBuild(client, dir);
  assert.ok(
    await until(
      async () => (await client.call("project_show", { project })).questions[0],
    ),
  );
  await client.call("rebuild_stop", { project });
  await client.call("rebuild_start", { project, resume: true, request: "Hello" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const activity = async () =>
    (await client.call("rebuild_activity_show", { project, limit: 100 })).lines.filter(
      (line) => line.includes("after the answer"),
    ).length;
  assert.equal(await activity(), 0, "the steps wait while the question is open");
  const status = await client.call("rebuild_status", { project });
  // Like 0.5.0: a waiting question reads building, counted in `waiting`.
  assert.equal(status.status, "building");
  assert.equal(status.waiting, 2, "the old one and the one asked again");
  const show = await client.call("project_show", { project });
  assert.deepEqual(
    show.questions.map((question) => question.id),
    ["q1", "q2"],
    "the old one stays listed, as in 0.5.0",
  );
  // Answering the old one succeeds and changes nothing; it is no longer listed.
  assert.equal(
    (await client.call("project_inbox_answer", { project, id: "q1", choice: "Red" }))
      .answered,
    "q1",
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await activity(), 0, "the old answer moves nothing");
  await assert.rejects(
    client.call("project_inbox_answer", { project, id: "q1", choice: "Red" }),
    (error) => error.code === "not_found",
  );
  await client.call("project_inbox_answer", { project, id: "q2", choice: "Red" });
  assert.ok(await until(async () => (await activity()) === 1));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await activity(), 1, "one step chain runs");
});

test("a tool error carries its code", async (t) => {
  const { start } = setup(t);
  const client = await start();
  await assert.rejects(client.call("rebuild_status", { project: "missing" }), (error) => {
    assert.equal(error.code, "project_not_found");
    assert.match(error.message, /missing/);
    return true;
  });
  assert.equal(client.alive, true);
});

test("refuses a server that does not offer rebuild_start", async (t) => {
  const { start } = setup(t, { script: { hideTools: ["rebuild_start"] } });
  await assert.rejects(start(), (error) => error.code === "CRAFT_MCP_NO_REBUILD");
});

test("close stops projects, ends the child and leaves no builder process", async (t) => {
  const { dir, start } = setup(t);
  const client = await start();
  const { project, folder, builder } = await startBuild(client, dir);
  assert.equal(exists(builder), true);
  const child = client.pid;
  const exits = [];
  client.onExit((event) => exits.push(event));
  const began = Date.now();
  await client.close({ stopProjects: [project] });
  assert.ok(Date.now() - began < 2500, "closing stdin ends the child without waiting");
  assert.equal(client.alive, false);
  assert.ok(await until(() => !exists(child), 2000));
  assert.ok(await until(() => !exists(builder), 2000));
  assert.equal(exits.length, 1);
  assert.equal(exits[0].expected, true);
  const record = JSON.parse(readFileSync(path.join(folder, "craft.json"), "utf8"));
  assert.equal(record.status, "stopped");
});

test("close ends within 4 s when no stop answers and the child ignores stdin", async (t) => {
  const { dir, start } = setup(t, {
    script: { slowTools: { rebuild_stop: 60000 }, ignoreStdinClose: true },
  });
  const client = await start();
  const one = await startBuild(client, dir, "one");
  const two = await startBuild(client, dir, "two");
  const child = client.pid;
  const began = Date.now();
  await client.close({ stopProjects: [one.project, two.project] });
  const took = Date.now() - began;
  assert.ok(took < 4000, `close took ${took} ms`);
  assert.ok(await until(() => ![child, one.builder, two.builder].some(exists), 2000));
});

test("close kills a builder the child left behind", async (t) => {
  const { dir, start } = setup(t);
  const client = await start();
  const { builder } = await startBuild(client, dir);
  // No rebuild_stop: the fake (like the real binary) exits on stdin close and
  // leaves its builder group running.
  await client.close();
  assert.ok(await until(() => !exists(builder), 2000));
});

test("descendant groups are killed when the child is gone", async (t) => {
  const { dir, start } = setup(t);
  const client = await start();
  const { builder } = await startBuild(client, dir);
  const exited = new Promise((resolve) => client.onExit(resolve));
  process.kill(client.pid, "SIGKILL");
  const event = await exited;
  assert.equal(event.expected, false);
  assert.equal(event.signal, "SIGKILL");
  assert.equal(client.alive, false);
  await client.close();
  assert.ok(await until(() => !exists(builder), 2000));
});

test("a call after exit is refused", async (t) => {
  const { start } = setup(t);
  const client = await start();
  const exited = new Promise((resolve) => client.onExit(resolve));
  process.kill(client.pid, "SIGKILL");
  await exited;
  await assert.rejects(
    client.call("rebuild_status", { project: "x" }),
    (error) => error.code === "CRAFT_MCP_CLOSED",
  );
  await client.close();
  await assert.rejects(
    client.call("rebuild_status", { project: "x" }),
    (error) => error.code === "CRAFT_MCP_CLOSED",
  );
});

test("a pending call is rejected when the child dies", async (t) => {
  const { start } = setup(t, { script: { slowTools: { rebuild_status: 10000 } } });
  const client = await start();
  const pending = client.call("rebuild_status", { project: "x" });
  setTimeout(() => process.kill(client.pid, "SIGKILL"), 100);
  await assert.rejects(pending, (error) => error.code === "CRAFT_MCP_EXITED");
});

test("a call that takes too long times out", async (t) => {
  const { start } = setup(t, { script: { slowTools: { rebuild_status: 10000 } } });
  const client = await start();
  await assert.rejects(
    client.call("rebuild_status", { project: "x" }, { timeoutMs: 100 }),
    (error) => error.code === "CRAFT_MCP_TIMEOUT",
  );
});
