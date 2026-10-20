import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NativeSessionBinding } from "../../server/features/sessions/native-session-binding.js";
import { recordNativeSession } from "../../server/features/sessions/native-session-binding.js";
import { recordNativeActivity } from "../../server/features/sessions/native-session-activity.js";
import { claudeInterruptAt } from "../../server/features/sessions/claude-interrupt.js";
import { SessionActivity } from "../../server/features/sessions/session-activity.js";
import { AccountStore } from "../../server/features/accounts/account-store.js";

const conversation = "11111111-1111-4111-8111-111111111111";
const row = (type, content, at, extra = {}) =>
  JSON.stringify({
    type,
    sessionId: conversation,
    timestamp: new Date(at).toISOString(),
    message: { role: type, content },
    ...extra,
  }) + "\n";

async function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-esc-")));
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  const transcript = path.join(root, "transcript.jsonl");
  fs.writeFileSync(transcript, "");
  const accounts = new AccountStore({ dataDir: path.join(root, "data"), home: root });
  const history = {
    claudeFile: async (_session, id) => (id === conversation ? transcript : null),
  };
  const bindings = new NativeSessionBinding({
    dataDir: accounts.dataDir,
    accounts,
    history,
  });
  const account = accounts.create({ name: "esc", tool: "claude" });
  const prepared = await bindings.prepare({
    id: "claude-esc",
    account,
    cwd,
    launch: {
      command: process.execPath,
      args: [],
      env: accounts.environment(account.id),
    },
  });
  const session = {
    id: "claude-esc",
    tool: "claude",
    accountId: account.id,
    cwd,
    status: "running",
    nativeBinding: prepared.nativeBinding,
  };
  recordNativeSession({ session_id: conversation, cwd }, prepared.env, {
    pid: process.pid,
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { bindings, prepared, session, transcript };
}

test("Claude's interrupt marker after a running turn ends the reported work", async (t) => {
  const f = await setup(t);
  const start = Date.now() - 5000;
  recordNativeActivity(
    { state: "working", event: "UserPromptSubmit", at: start },
    f.prepared.env,
  );
  fs.appendFileSync(f.transcript, row("user", "Write a long poem", start));
  fs.appendFileSync(
    f.transcript,
    row("assistant", [{ type: "text", text: "Roses are" }], start + 1000),
  );
  assert.equal((await f.bindings.reportedActivity(f.session)).state, "working");
  fs.appendFileSync(
    f.transcript,
    row("user", [{ type: "text", text: "[Request interrupted by user]" }], start + 2000),
  );
  // A metadata row after the marker does not hide it.
  fs.appendFileSync(
    f.transcript,
    JSON.stringify({ type: "file-history-snapshot" }) + "\n",
  );
  const ended = await f.bindings.reportedActivity(f.session);
  assert.deepEqual(
    [ended.state, ended.event, ended.at],
    ["idle", "Interrupt", start + 2000],
  );
  assert.equal(f.bindings.activity(f.session).state, "idle");
  // The session list reads it through SessionActivity like a hook report.
  const read = await new SessionActivity({
    sessions: {},
    screen: async () => "unrecognized narrow pane",
    hooks: (value) => f.bindings.reportedActivity(value),
    cacheMs: 0,
  }).read(f.session);
  assert.deepEqual([read.state, read.source], ["idle", "hook"]);
  // The next prompt's hook is newer and counts again.
  recordNativeActivity(
    { state: "working", event: "UserPromptSubmit", at: start + 3000 },
    f.prepared.env,
  );
  assert.equal((await f.bindings.reportedActivity(f.session)).state, "working");
});

test("an older marker, a later reply or a tool-use interrupt are told apart", async (t) => {
  const f = await setup(t);
  const start = Date.now() - 5000;
  fs.appendFileSync(
    f.transcript,
    row("user", "[Request interrupted by user]", start - 1000),
  );
  recordNativeActivity(
    { state: "working", event: "UserPromptSubmit", at: start },
    f.prepared.env,
  );
  // A marker from before the running turn is old news.
  assert.equal((await f.bindings.reportedActivity(f.session)).state, "working");
  fs.appendFileSync(f.transcript, row("user", "Next task", start + 100));
  assert.equal((await f.bindings.reportedActivity(f.session)).state, "working");
  // A sub-agent's marker is not the main turn's.
  fs.appendFileSync(
    f.transcript,
    row("user", "[Request interrupted by user]", start + 200, { isSidechain: true }),
  );
  assert.equal((await f.bindings.reportedActivity(f.session)).state, "working");
  fs.appendFileSync(
    f.transcript,
    row(
      "user",
      [{ type: "text", text: "[Request interrupted by user for tool use]" }],
      start + 300,
    ),
  );
  assert.equal(await claudeInterruptAt(f.transcript, start), start + 300);
  assert.equal(await claudeInterruptAt(f.transcript, start + 300), null);
  // A permission wait interrupted with Esc ends as well.
  recordNativeActivity(
    { state: "waiting", event: "PermissionRequest", at: start + 250 },
    f.prepared.env,
  );
  assert.equal((await f.bindings.reportedActivity(f.session)).state, "idle");
});

test("the marker is ignored while it is not the newest conversation row", async (t) => {
  const f = await setup(t);
  const start = Date.now() - 5000;
  recordNativeActivity(
    { state: "working", event: "UserPromptSubmit", at: start },
    f.prepared.env,
  );
  fs.appendFileSync(
    f.transcript,
    row("user", "[Request interrupted by user]", start + 100),
  );
  fs.appendFileSync(
    f.transcript,
    row("assistant", [{ type: "text", text: "Ok" }], start + 200),
  );
  assert.equal(await claudeInterruptAt(f.transcript, start), null);
  // A half-written last line is skipped, not misread.
  fs.appendFileSync(f.transcript, '{"type":"user","message":{"content":"[Request interr');
  assert.equal(await claudeInterruptAt(f.transcript, start), null);
  assert.equal((await f.bindings.reportedActivity(f.session)).state, "working");
  // Codex and other tools keep their own reports.
  assert.equal(await f.bindings.reportedActivity({ ...f.session, tool: "codex" }), null);
});
