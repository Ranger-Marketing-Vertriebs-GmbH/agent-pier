import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applicationFixture } from "../helpers/application.js";

const execute = promisify(execFile);
async function until(read, accept) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const result = await read();
    if (accept(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail("Synthetic session did not reach expected state.");
}

test("real app reload resumes exact Claude history with fresh SSH tools and retained grants/attachments", async (t) => {
  const f = await applicationFixture(t);
  const app = f.application;
  const account = app.accounts.create({ name: "Reload fixture", tool: "claude" });
  const cli = path.join(f.root, "synthetic-claude.mjs");
  const capture = path.join(f.root, "launches.jsonl");
  const failStartup = path.join(f.root, "fail-startup");
  const approveHooks = path.join(f.root, "approve-hooks");
  const bindingModule = new URL(
    "../../server/features/sessions/native-session-binding.js",
    import.meta.url,
  ).href;
  await fs.writeFile(
    cli,
    `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import { recordNativeSession } from ${JSON.stringify(bindingModule)};
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.263'); process.exit(0); }
const resumed = args.includes('--resume');
if (resumed && fs.existsSync(${JSON.stringify(failStartup)})) process.exit(23);
const nativeId = args[args.indexOf(resumed ? '--resume' : '--session-id') + 1];
const cwd = process.cwd();
const root = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude');
const folder = path.join(root, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(folder, {recursive: true});
const history = path.join(folder, nativeId + '.jsonl');
if (!resumed) fs.writeFileSync(history, JSON.stringify({type:'user',uuid:'fixture-message',sessionId:nativeId,cwd,timestamp:new Date().toISOString(),message:{role:'user',content:'Keep this saved conversation'}})+'\\n');
while (resumed && !fs.existsSync(${JSON.stringify(approveHooks)})) await new Promise(resolve => setTimeout(resolve, 40));
recordNativeSession({session_id:nativeId,cwd}, process.env, {pid:process.pid});
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({args,nativeId,pid:process.pid})+'\\n');
console.log('Synthetic CLI ready');
process.stdin.resume();
setInterval(()=>{},1000);
`,
    { mode: 0o700 },
  );
  const original = app.accounts.command.bind(app.accounts);
  app.accounts.command = (id, _binaries, login, mode, options) =>
    original(id, { claude: cli }, login, mode, options);
  const key = path.join(f.root, "synthetic-key");
  await execute("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const access = await app.sshAccesses.create({
    name: "Synthetic host",
    host: "192.0.2.1",
    username: "fixture",
    privateKey: await fs.readFile(key, "utf8"),
    hostKey: (await fs.readFile(key + ".pub", "utf8")).trim(),
  });
  const response = await f.request("/api/sessions", {
    method: "POST",
    body: {
      accountId: account.id,
      cwd: f.home,
      agentbus: false,
      sshAccessIds: [access.id],
    },
  });
  assert.equal(response.status, 201, await response.clone().text());
  const session = await response.json();
  const endpoint = `/api/sessions/${session.id}/reload`;
  assert.equal((await fetch(f.url + endpoint)).status, 401);
  const status = await until(
    async () => (await f.request(endpoint)).json(),
    (value) => value.eligible,
  );
  assert.equal(status.nativeId, session.id);
  assert.equal(session.agentbus.enabled, false);
  assert.equal(session.sshTools.enabled, true);
  const attachment = path.join(session.attachments.directory, "retained.txt");
  await fs.writeFile(attachment, "retained fixture");
  const requestId = randomUUID();
  const reload = await f.request(endpoint, {
    method: "POST",
    body: { requestId, mode: "now", interrupt: true },
  });
  assert.ok(reload.ok, await reload.clone().text());
  const result = await reload.json();
  assert.equal(result.state, "reloading", JSON.stringify(result));
  await fs.writeFile(approveHooks, "approved");
  await until(
    async () => (await f.request(endpoint)).json(),
    (value) => value.state === "completed",
  );
  const launches = await until(
    async () => (await fs.readFile(capture, "utf8")).trim().split("\n").map(JSON.parse),
    (rows) => rows.length === 2,
  );
  assert.equal(launches[1].nativeId, session.id);
  assert.ok(launches[1].args.includes("--resume"));
  assert.equal(launches[1].args.includes("--session-id"), false);
  assert.notEqual(launches[0].pid, launches[1].pid);
  const current = await app.sessions.get(session.id);
  assert.equal(current.createdAt, session.createdAt);
  assert.equal(current.accountId, account.id);
  assert.equal(current.cwd, session.cwd);
  assert.deepEqual(current.attachments, session.attachments);
  assert.equal(await fs.readFile(attachment, "utf8"), "retained fixture");
  assert.deepEqual(app.sshSessions.assigned(current), [access.id]);
  assert.notEqual(current.sshTools.generation, session.sshTools.generation);
  assert.equal((await app.bindings.resolve(current)).id, session.id);
  assert.equal(
    (await app.history.read(current, session.id)).messages[0].text,
    "Keep this saved conversation",
  );
  const duplicate = await f.request(endpoint, {
    method: "POST",
    body: { requestId, mode: "now", interrupt: true },
  });
  assert.equal((await duplicate.json()).state, "completed");
  assert.equal((await fs.readFile(capture, "utf8")).trim().split("\n").length, 2);

  // tmux starting successfully is not enough: a native CLI can reject resume.
  await fs.writeFile(failStartup, "synthetic startup failure");
  const failed = await f.request(endpoint, {
    method: "POST",
    body: { requestId: randomUUID(), mode: "now", interrupt: true },
  });
  assert.ok(["reloading", "failed"].includes((await failed.json()).state));
  await until(
    async () => (await f.request(endpoint)).json(),
    (value) => value.state === "failed",
  );
  assert.deepEqual(app.sshSessions.assigned(await app.sessions.get(session.id)), [
    access.id,
  ]);
  await f.restart();
  const recovered = await (await f.request(endpoint)).json();
  assert.equal(recovered.state, "failed");
  assert.equal(recovered.nativeId, session.id);
  assert.equal(recovered.eligible, true);
  assert.deepEqual(
    f.application.sshSessions.assigned(await f.application.sessions.get(session.id)),
    [access.id],
  );
  await fs.rm(failStartup);
  const recoveredCommand = f.application.accounts.command.bind(f.application.accounts);
  f.application.accounts.command = (id, _binaries, login, mode, options) =>
    recoveredCommand(id, { claude: cli }, login, mode, options);
  const retry = await f.request(endpoint, {
    method: "POST",
    body: { requestId: randomUUID(), mode: "now" },
  });
  const retried = await retry.json();
  assert.ok(["reloading", "completed"].includes(retried.state), JSON.stringify(retried));
  await until(
    async () => (await f.request(endpoint)).json(),
    (value) => value.state === "completed",
  );
  assert.equal(await fs.readFile(attachment, "utf8"), "retained fixture");
});
