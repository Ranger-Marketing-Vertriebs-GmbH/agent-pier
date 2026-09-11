import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import express from "express";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { requestsRoutes } from "../../server/http/routes/requests.js";
import { NativeRequestChannel } from "../../server/features/requests/native-channel.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-request-http-"));
  const session = {
    id: "session",
    tool: "claude",
    accountId: "account",
    status: "running",
    nativeRequests: { enabled: true },
  };
  const broker = new RequestBroker({
    dataDir: root,
    sessions: {
      get: async (id) => {
        if (id !== "session") throw Object.assign(Error("Not found"), { status: 404 });
        return session;
      },
    },
  });
  const launch = await broker.prepare({
    id: session.id,
    account: { id: "account", tool: "claude" },
    cwd: root,
    launch: { command: "claude", args: [], env: {} },
  });
  const app = express();
  app.use(express.json());
  app.use(requestsRoutes({ requests: broker }));
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/sessions/session/requests`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await broker.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { broker, launch, root, url };
}
async function poll(url) {
  for (let i = 0; i < 200; i++) {
    const body = await (await fetch(url)).json();
    if (body.requests.length) return body.requests[0];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Native request missing");
}
const post = (url, body) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
for (const [event, question] of [
  ["PermissionRequest", false],
  ["PreToolUse", true],
  ["PermissionRequest", true],
])
  test(`real Claude ${event} hook resolves ${question ? "question" : "permission"} through public HTTP without PTY typing`, async (t) => {
    const { launch, url, root } = await fixture(t);
    const child = spawn(
      process.execPath,
      [path.resolve("server/features/requests/claude-hook.js")],
      { cwd: root, env: launch.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    t.after(() => child.kill());
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    const ended = once(child, "close");
    const questions = [
      {
        question: "Choose?",
        header: "Choice",
        options: [
          { label: "One", description: "First" },
          { label: "Two", description: "Second" },
        ],
        multiSelect: false,
      },
    ];
    child.stdin.end(
      JSON.stringify({
        session_id: "native-session",
        cwd: root,
        tool_use_id: "native-call",
        hook_event_name: event,
        tool_name: question ? "AskUserQuestion" : "Bash",
        tool_input: question ? { questions } : { command: "printf fixture" },
      }),
    );
    const ask = await poll(url);
    assert.equal(ask.kind, question ? "question" : "permission");
    if (question) {
      assert.equal(ask.questions[0].prompt, "Choose?");
      assert.deepEqual(
        ask.questions[0].options.map((option) => option.label),
        ["One", "Two"],
      );
      const bareApproval = await post(`${url}/${ask.id}/answer`, {
        expectedRevision: 1,
        choice: "allow",
      });
      assert.equal(bareApproval.status, 400);
    }
    assert.equal(JSON.stringify(ask).includes(launch.env.AGENTPIER_REQUEST_TOKEN), false);
    assert.equal(JSON.stringify(ask).includes("native-call"), false);
    const response = await post(`${url}/${ask.id}/answer`, {
      expectedRevision: 1,
      ...(question ? { answers: { q0: ["Two"] } } : { choice: "deny" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { requests: [] });
    assert.equal(
      (await post(`${url}/${ask.id}/answer`, { expectedRevision: 1, choice: "allow" }))
        .status,
      409,
    );
    await ended;
    const output = JSON.parse(stdout);
    if (question)
      assert.deepEqual(
        (event === "PermissionRequest"
          ? output.hookSpecificOutput.decision
          : output.hookSpecificOutput
        ).updatedInput,
        {
          questions,
          answers: { "Choose?": "Two" },
        },
      );
    else
      assert.deepEqual(output, {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "deny" },
        },
      });
  });

test("uncertain native delivery stays non-retryable and HTTP never resends an answer", async (t) => {
  const { launch, url } = await fixture(t);
  const channel = new NativeRequestChannel({ env: launch.env });
  t.after(() => channel.close());
  await channel.ready;
  let attempts = 0;
  channel.publish(
    "native",
    { kind: "permission", options: [{ id: "allow", label: "Allow" }] },
    async () => {
      attempts++;
      throw Error("Connection failed after native delivery");
    },
  );
  const ask = await poll(url);
  assert.equal(
    (await post(`${url}/${ask.id}/answer`, { expectedRevision: 1, choice: "allow" }))
      .status,
    409,
  );
  const uncertain = await poll(url);
  assert.equal(uncertain.status, "unknown");
  assert.equal(
    (
      await post(`${url}/${ask.id}/answer`, {
        expectedRevision: uncertain.revision,
        choice: "allow",
      })
    ).status,
    409,
  );
  assert.equal(
    (await post(`${url}/${ask.id}/handoff`, { expectedRevision: uncertain.revision }))
      .status,
    409,
  );
  assert.equal(attempts, 1);
});

test("web service disconnect releases a waiting Claude hook back to its native Terminal", async (t) => {
  const { broker, launch, url, root } = await fixture(t);
  const child = spawn(
    process.execPath,
    [path.resolve("server/features/requests/claude-hook.js")],
    { cwd: root, env: launch.env, stdio: ["pipe", "pipe", "pipe"] },
  );
  t.after(() => child.kill());
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const ended = once(child, "close");
  child.stdin.end(
    JSON.stringify({
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "fixture" },
    }),
  );
  await poll(url);
  await broker.close();
  let timer;
  const closed = await Promise.race([
    ended.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 2000);
    }),
  ]);
  clearTimeout(timer);
  assert.equal(
    closed,
    true,
    "native Terminal must not wait for the web service to return",
  );
  assert.equal((await ended)[0], 0, "native hook handoff is a successful empty decision");
  assert.equal(stdout, "");
});
