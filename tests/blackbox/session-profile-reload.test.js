import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";

async function until(read, accept, ms = 10000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`State not reached: ${JSON.stringify(last)?.slice(0, 600)}`);
}

// A synthetic Claude CLI that records its arguments and binds its native session.
async function syntheticClaude(f) {
  const cli = path.join(f.root, "synthetic-claude.mjs");
  const capture = path.join(f.root, "launches.jsonl");
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
const nativeId = args[args.indexOf(resumed ? '--resume' : '--session-id') + 1];
const cwd = process.cwd();
const root = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude');
const folder = path.join(root, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(folder, {recursive: true});
const history = path.join(folder, nativeId + '.jsonl');
if (!resumed) fs.writeFileSync(history, JSON.stringify({type:'user',uuid:'m1',sessionId:nativeId,cwd,timestamp:new Date().toISOString(),message:{role:'user',content:'hello'}})+'\\n');
recordNativeSession({session_id:nativeId,cwd}, process.env, {pid:process.pid});
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({args})+'\\n');
console.log('Synthetic CLI ready');
process.stdin.resume();
setInterval(()=>{},1000);
`,
    { mode: 0o700 },
  );
  const app = f.application;
  const original = app.accounts.command.bind(app.accounts);
  app.accounts.command = (id, _binaries, login, mode, options) =>
    original(id, { claude: cli }, login, mode, options);
  return () =>
    fs
      .readFile(capture, "utf8")
      .then((text) => text.trim().split("\n").filter(Boolean).map(JSON.parse))
      .catch(() => []);
}

async function profileSession(f, mode) {
  const account = f.application.accounts.create({ name: "Profile", tool: "claude" });
  const launches = await syntheticClaude(f);
  const seed = (await (await f.request("/api/pipeline-profiles")).json()).profiles.find(
    (profile) => profile.seedKey === "implementer",
  );
  const created = await f.request("/api/pipeline-profiles", {
    method: "POST",
    body: {
      ...seed,
      name: "Plan profile",
      config: {
        ...seed.config,
        accountId: account.id,
        cliTool: "claude",
        permissions: { mode },
        models: { default: "claude-sonnet-4-6", available: ["claude-sonnet-4-6"] },
      },
    },
  });
  assert.equal(created.status, 201, await created.clone().text());
  const { profile } = await created.json();
  const launched = await f.request(`/api/pipeline-profiles/${profile.id}/launch`, {
    method: "POST",
    body: { cwd: f.home, agentbus: false, agentpierTools: false, params: {} },
  });
  assert.equal(launched.status, 201, await launched.clone().text());
  const { session } = await launched.json();
  await until(launches, (rows) => rows.length === 1);
  await until(
    async () => (await f.request(`/api/sessions/${session.id}/reload`)).json(),
    (value) => value.eligible,
  );
  return { profile, session, launches };
}

const permissionMode = (args) => args[args.indexOf("--permission-mode") + 1];

test("Reload & resume keeps the permission mode a task profile launched with", async (t) => {
  const f = await applicationFixture(t);
  const { profile, session, launches } = await profileSession(f, "plan");
  // A later profile edit does not affect the running session.
  const edited = await f.request(`/api/pipeline-profiles/${profile.id}`, {
    method: "PATCH",
    body: {
      ...profile,
      expectedRevision: profile.revision,
      config: { ...profile.config, permissions: { mode: "dontAsk" } },
    },
  });
  assert.ok(edited.ok, await edited.clone().text());
  const reload = await f.request(`/api/sessions/${session.id}/reload`, {
    method: "POST",
    body: { requestId: randomUUID(), mode: "now", interrupt: true },
  });
  assert.ok(reload.ok, await reload.clone().text());
  const rows = await until(launches, (rows) => rows.length === 2);
  assert.equal(permissionMode(rows[0].args), "plan");
  assert.ok(rows[1].args.includes("--resume"), JSON.stringify(rows[1].args));
  assert.equal(permissionMode(rows[1].args), "plan", JSON.stringify(rows[1].args));
  assert.equal(rows[1].args.filter((arg) => arg === "--permission-mode").length, 1);
});

test("automatic resume keeps the permission mode a task profile launched with", async (t) => {
  const f = await applicationFixture(t);
  const { launches } = await profileSession(f, "acceptEdits");
  // Only this fixture's private tmux server.
  await f.application.sessions.tmux(["kill-server"]);
  await f.application.sessions.list();
  const rows = await until(launches, (rows) => rows.length === 2, 20000);
  assert.ok(rows[1].args.includes("--resume"), JSON.stringify(rows[1].args));
  assert.equal(permissionMode(rows[1].args), "acceptEdits", JSON.stringify(rows[1].args));
});
