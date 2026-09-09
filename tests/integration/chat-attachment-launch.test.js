import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { attachmentDirectory } from "../../server/features/chat/chat-attachments.js";

// The sandbox has no real `claude` binary installed. Swap in `/bin/sh` for the
// actual process (it exits instantly, which also drives the session to
// "stopped" so the delete test does not need a separate stop call) while
// still exercising the real account/launch pipeline that computes --add-dir
// and --session-id onto the returned launch object.
function stubClaudeExecutable(f, script = "true") {
  const original = f.application.accounts.command.bind(f.application.accounts);
  f.application.accounts.command = (id, _binaries, login, mode, options) => ({
    ...original(id, { claude: "/bin/sh" }, login, mode, options),
    command: "/bin/sh",
    args: ["-c", script],
  });
}

// The stubbed process exits almost instantly, but tmux still needs a moment to
// report the pane dead; poll rather than race the DELETE against that.
async function untilStopped(f, id, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if ((await f.application.sessions.get(id)).status === "stopped") return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail("Timed out waiting for the stubbed session to stop");
}

test("a launched claude session records its attachment directory and passes --add-dir", async (t) => {
  const f = await applicationFixture(t);
  const capture = path.join(f.root, "claude-arguments.json");
  const executable = path.join(f.root, "capture-claude.mjs");
  fs.writeFileSync(
    executable,
    'import fs from "node:fs"; fs.writeFileSync(process.env.ARGUMENT_CAPTURE, JSON.stringify(process.argv.slice(2)));',
  );
  const original = f.application.accounts.command.bind(f.application.accounts);
  f.application.accounts.command = (id, _binaries, login, mode, options) => {
    const launch = original(id, { claude: process.execPath }, login, mode, options);
    return {
      ...launch,
      command: process.execPath,
      args: [executable],
      env: { ...launch.env, ARGUMENT_CAPTURE: capture },
    };
  };
  const cwd = path.join(f.root, "project");
  fs.mkdirSync(cwd);
  const session = await f.application.launch({ accountId: "local-claude", cwd });
  const expected = attachmentDirectory(
    f.application.config.dataDir,
    session.accountId,
    session.id,
  );
  assert.equal(session.attachments.directory, expected);
  assert.equal(fs.statSync(expected).isDirectory(), true);
  // Launch metadata is intentionally cleaned up when the process exits. Read
  // the arguments observed by the executable, which remain after that cleanup.
  await untilStopped(f, session.id);
  const args = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.equal(args.includes("--add-dir"), true);
  assert.equal(args[args.indexOf("--add-dir") + 1], expected);
});

test("deleting a session removes its attachment directory", async (t) => {
  const f = await applicationFixture(t);
  stubClaudeExecutable(f);
  const cwd = path.join(f.root, "project");
  fs.mkdirSync(cwd);
  const session = await f.application.launch({ accountId: "local-claude", cwd });
  const directory = session.attachments.directory;
  fs.writeFileSync(path.join(directory, "kept.png"), "x");
  await untilStopped(f, session.id);
  const response = await f.request(`/api/sessions/${session.id}`, {
    method: "DELETE",
  });
  assert.equal(response.status, 204);
  assert.equal(fs.existsSync(directory), false);
});

test("deleting a running session is rejected and keeps its attachment directory intact", async (t) => {
  const f = await applicationFixture(t);
  // Long enough that the pane is still reliably "running" when DELETE fires.
  stubClaudeExecutable(f, "sleep 5");
  const cwd = path.join(f.root, "project");
  fs.mkdirSync(cwd);
  const session = await f.application.launch({ accountId: "local-claude", cwd });
  const directory = session.attachments.directory;
  const file = path.join(directory, "kept.png");
  fs.writeFileSync(file, "x");
  const response = await f.request(`/api/sessions/${session.id}`, {
    method: "DELETE",
  });
  assert.equal(response.status, 409);
  assert.equal(fs.existsSync(directory), true);
  assert.equal(fs.readFileSync(file, "utf8"), "x");
});

test("a launch that fails after the attachment grant rolls back the directory it created", async (t) => {
  const f = await applicationFixture(t);
  stubClaudeExecutable(f);
  const cwd = path.join(f.root, "project");
  fs.mkdirSync(cwd);
  const boom = new Error("synthetic failure injected after the attachment grant");
  f.application.github.prepare = async () => {
    throw boom;
  };
  await assert.rejects(
    () => f.application.launch({ accountId: "local-claude", cwd }),
    boom,
  );
  const accountDirectory = path.join(
    f.application.config.dataDir,
    "chat-attachments",
    "local-claude",
  );
  const leftovers = fs.existsSync(accountDirectory)
    ? fs.readdirSync(accountDirectory)
    : [];
  assert.deepEqual(leftovers, []);
});
