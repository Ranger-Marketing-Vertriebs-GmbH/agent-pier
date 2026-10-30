import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { runClaudeHook } from "../../server/features/requests/claude-hook.js";

// A request broker in a disposable data directory with one running Claude session,
// and Claude hook invocations against it (claude-hook.js).
export const workflow = {
  hook_event_name: "PermissionRequest",
  tool_name: "Workflow",
  tool_input: {
    script:
      "export const meta = { name: 'nightly-review', description: 'Review open PRs' };\n",
  },
};
export async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-claude-permission-"));
  const session = {
    id: "session",
    tool: "claude",
    accountId: "account",
    status: "running",
    nativeRequests: { enabled: true },
    // A plain folder is a project of its own (remembered project approvals).
    cwd: root,
  };
  const events = [];
  const config = {
    dataDir: root,
    sessions: { get: async () => session },
    onEvent: (event) => events.push(event),
  };
  let broker = new RequestBroker(config);
  const launch = await broker.prepare({
    id: session.id,
    account: { id: session.accountId, tool: "claude" },
    cwd: root,
    launch: { command: "claude", args: [], env: {} },
  });
  t.after(async () => {
    await broker.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    session,
    launch,
    events,
    get broker() {
      return broker;
    },
    async restart() {
      await broker.close();
      broker = new RequestBroker(config);
      await broker.ready;
    },
  };
}
export function hook(f, payload = workflow, options = {}) {
  let written = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      written += chunk;
      callback();
    },
  });
  const input = Readable.from([JSON.stringify(payload)]);
  let ended = false;
  const done = runClaudeHook({ input, output, env: f.launch.env, ...options }).then(
    () => {
      ended = true;
    },
  );
  return { done, output: () => written, ended: () => ended };
}
// Polls through I/O turns only, so it also works while setTimeout is mocked.
export async function waitFor(read, predicate) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw Error("Claude permission observation timed out");
}
export const turns = async (count = 50) => {
  for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve));
};
// Claude records the tool call in its transcript before asking for approval.
export const toolUse = (payload, id = "toolu_probe") =>
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id, name: payload.tool_name, input: payload.tool_input },
      ],
    },
  }) + "\n";
export const toolResult = (id = "toolu_probe") =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "done" }] },
  }) + "\n";
export async function transcribed(f, payload = workflow) {
  const file = path.join(f.root, "transcript.jsonl");
  await fs.writeFile(
    file,
    '{"type":"user","message":{"content":"Go"}}\n' + toolUse(payload),
  );
  return { ...payload, transcript_path: file };
}
export const state = (f) => f.broker.list("session");
export const pending = (f) =>
  waitFor(
    () => state(f),
    (value) => value.requests.length === 1,
  ).then((value) => value.requests[0]);
