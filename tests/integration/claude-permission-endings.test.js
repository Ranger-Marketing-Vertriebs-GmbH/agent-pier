import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  fixture,
  hook,
  pending,
  state,
  toolResult,
  toolUse,
  transcribed,
  waitFor,
  workflow,
} from "../helpers/claude-hook-fixture.js";

const bash = {
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "touch marker", description: "Write marker" },
};
// A later assistant message with a call of its own: Claude moved on.
const laterCall = (id, name = "Read", message = "msg_later") =>
  JSON.stringify({
    type: "assistant",
    message: {
      id: message,
      content: [{ type: "tool_use", id, name, input: { file_path: "/x" } }],
    },
  }) + "\n";
const ended = (f, id) =>
  waitFor(
    async () =>
      f.events.find(
        (event) => event.action === "request.expired" && event.resourceId === id,
      ),
    Boolean,
  );

test("an unmatched card closes as stale once Claude makes a later call", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, "transcript.jsonl");
  // Claude recorded the call with an input the hook does not see the same way.
  await fs.writeFile(
    file,
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_now",
        content: [{ type: "tool_use", id: "toolu_now", name: "Bash", input: { x: 1 } }],
      },
    }) + "\n",
  );
  const run = hook(f, { ...bash, transcript_path: file }, { timeout: 20_000 });
  const request = await pending(f);
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(run.ended(), false, "nothing decided yet");
  await fs.appendFile(file, laterCall("toolu_later"));
  await run.done;
  assert.equal(run.output(), "");
  assert.equal((await ended(f, request.id)).details.cause, "stale");
  assert.equal((await state(f)).notice, undefined, "a stale card leaves no notice");
});

test("an unmatched card closes when the open call of its tool gets a result", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, "transcript.jsonl");
  await fs.writeFile(
    file,
    toolUse({ tool_name: "Bash", tool_input: { command: "touch marker" } }, "toolu_open"),
  );
  const run = hook(f, { ...bash, transcript_path: file }, { timeout: 20_000 });
  const request = await pending(f);
  // Approved (or denied) in the terminal: Claude records the call's result.
  await fs.appendFile(file, toolResult("toolu_open"));
  await run.done;
  assert.equal(run.output(), "");
  assert.equal((await ended(f, request.id)).details.cause, "native");
});

test("a matched card ignores a later call until its own result arrives", async (t) => {
  const f = await fixture(t);
  const payload = await transcribed(f);
  const run = hook(f, payload, { timeout: 20_000 });
  const request = await pending(f);
  await fs.appendFile(payload.transcript_path, laterCall("toolu_parallel", "Read", "m2"));
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(run.ended(), false, "the exact call still waits for its decision");
  await fs.appendFile(payload.transcript_path, toolResult());
  await run.done;
  assert.equal((await ended(f, request.id)).details.cause, "native");
});

test("a closed channel and a discarded session record their cause", async (t) => {
  const f = await fixture(t);
  const run = hook(f, workflow, { timeout: 20_000 });
  const first = await pending(f);
  for (const socket of f.broker.clients) socket.destroy();
  assert.equal((await ended(f, first.id)).details.cause, "socket");
  // The hook reconnects and publishes the same request again; the session then ends.
  await pending(f);
  await f.broker.discard("session", { removeLaunch: false });
  const causes = f.events
    .filter((event) => event.action === "request.expired")
    .map((event) => event.details.cause);
  assert.deepEqual(causes, ["socket", "discard"]);
  await f.broker.close();
  await run.done;
});

test("a hook from an older release hands its waiting request to the current hook", async (t) => {
  const f = await fixture(t);
  let connections = 0;
  const connection = f.broker.connection.bind(f.broker);
  f.broker.server.removeAllListeners("connection");
  f.broker.server.on("connection", (socket) => {
    connections++;
    connection(socket);
  });
  // This invocation pretends to run an outdated release's file; the broker names
  // the current one, so the dispatcher starts the current hook for the request.
  const run = hook(f, workflow, {
    timeout: 20_000,
    script: path.join(f.root, "releases/1.0.0/server/features/requests/claude-hook.js"),
  });
  const request = await pending(f);
  assert.equal(request.status, "pending");
  // The successor joined under the same epoch; the outdated socket is gone.
  await waitFor(
    async () => connections,
    (count) => count === 2,
  );
  await waitFor(
    async () => f.broker.clients.size,
    (size) => size === 1,
  );
  await f.broker.answer("session", request.id, { expectedRevision: 1, choice: "allow" });
  await run.done;
  assert.deepEqual(JSON.parse(run.output()).hookSpecificOutput, {
    hookEventName: "PermissionRequest",
    decision: { behavior: "allow" },
  });
  const actions = f.events.map((event) => event.action);
  assert.deepEqual(actions, ["request.created", "request.answered"]);
});

test("a startup screen's audit is marked apart from tool permissions", async (t) => {
  const f = await fixture(t);
  const entry = { id: "x", sessionId: "session", kind: "permission" };
  f.broker.expired({ ...entry, presentation: "claudeStartupPrompt" }, "startup");
  f.broker.expired(entry, "timeout");
  const [startup, tool] = f.events;
  assert.deepEqual(startup.details, {
    kind: "permission",
    startup: true,
    cause: "startup",
  });
  assert.deepEqual(tool.details, { kind: "permission", cause: "timeout" });
});
