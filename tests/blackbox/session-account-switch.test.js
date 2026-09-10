import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";

async function until(read, accept) {
  for (let n = 0; n < 150; n++) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail("Native fixture did not become ready");
}
for (const tool of ["codex", "claude"]) {
  test(`${tool}: switch account retains conversation, isolates credentials and recovers failed startup`, async (t) => {
    const f = await applicationFixture(t),
      app = f.application;
    const source = app.accounts.create({ name: "First", tool });
    const target = app.accounts.create({ name: "Second", tool });
    const wrong = app.accounts.create({
      name: "Other CLI",
      tool: tool === "codex" ? "claude" : "codex",
    });
    const cli = path.join(f.root, "fixture-cli.mjs"),
      capture = path.join(f.root, "launches.jsonl"),
      fail = path.join(f.root, "fail");
    const binding = new URL(
      "../../server/features/sessions/native-session-binding.js",
      import.meta.url,
    ).href;
    await fs.writeFile(
      cli,
      `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import {recordNativeSession} from ${JSON.stringify(binding)};
const args = process.argv.slice(2);
if(args.includes('--version')) {console.log('0.153.4'); process.exit(0);}
if(args.includes('app-server')) {process.stdin.resume(); await new Promise(()=>setInterval(()=>{},1000));}
const launch = JSON.parse(fs.readFileSync(process.env.AGENTPIER_NATIVE_BINDING_FILE));
const resume = args.includes('resume') || args.includes('--resume');
if(resume && fs.existsSync(${JSON.stringify(fail)})) process.exit(23);
const id = resume ? args[args.indexOf(${JSON.stringify(tool === "codex" ? "resume" : "--resume")})+1] : launch.id;
const root = process.env.${tool === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"};
const file = ${tool === "codex" ? "path.join(root,'sessions','2026','09','09','rollout-'+id+'.jsonl')" : "path.join(root,'projects',process.cwd().replace(/[^a-zA-Z0-9]/g,'-'),id+'.jsonl')"};
fs.mkdirSync(path.dirname(file),{recursive:true});
if(!resume) fs.writeFileSync(file,JSON.stringify(${tool === "codex" ? "{type:'session_meta',payload:{id,cwd:process.cwd()}}" : "{type:'user',uuid:'message',sessionId:id,cwd:process.cwd(),message:{role:'user',content:'Keep this conversation'}}"})+'\\n');
if(!fs.existsSync(file)) process.exit(25);
recordNativeSession({session_id:id,cwd:process.cwd()},process.env,{pid:process.pid});
fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({root,id,args})+'\\n');
console.log('Ready'); process.stdin.resume(); setInterval(()=>{},1000);
`,
      { mode: 0o700 },
    );
    const command = app.accounts.command.bind(app.accounts);
    app.accounts.command = (id, _binaries, login, mode, opts) =>
      command(id, { [tool]: cli }, login, mode, opts);
    const root = (account) =>
      app.accounts.environment(account.id)[
        tool === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"
      ];
    await fs.writeFile(path.join(root(source), "auth.json"), "source credentials");
    await fs.writeFile(path.join(root(target), "auth.json"), "target credentials");
    if (tool === "codex") {
      // Substitute only the history RPC boundary; the real account/HTTP/tmux/binding lifecycle runs.
      app.history.codex = (session) => ({
        request: async (_method, { threadId }) => ({
          thread: {
            id: threadId,
            cwd: session.cwd,
            path: path.join(
              root({ id: session.accountId }),
              "sessions/2026/09/09",
              `rollout-${threadId}.jsonl`,
            ),
          },
        }),
      });
      app.history.read = async () => ({ messages: [], observability: {} });
    }
    const created = await f.request("/api/sessions", {
      method: "POST",
      body: { accountId: source.id, cwd: f.home, agentbus: false },
    });
    assert.equal(created.status, 201, await created.clone().text());
    const session = await created.json(),
      endpoint = `/api/sessions/${session.id}/reload`;
    const status = await until(
      async () => (await f.request(endpoint)).json(),
      (value) => value.eligible,
    );
    assert.ok(status.accountTargets.some((a) => a.id === target.id));
    assert.equal(
      status.accountTargets.some((a) => a.id === wrong.id),
      false,
    );
    const invalid = await f.request(endpoint, {
      method: "POST",
      body: {
        mode: "now",
        interrupt: true,
        requestId: randomUUID(),
        targetAccountId: wrong.id,
      },
    });
    assert.equal(invalid.status, 409);
    assert.equal((await app.sessions.get(session.id)).accountId, source.id);
    const otherResponse = await f.request("/api/sessions", {
      method: "POST",
      body: { accountId: target.id, cwd: f.home, agentbus: false },
    });
    const other = await otherResponse.json();
    await until(
      async () => app.bindings.resolve(await app.sessions.get(other.id)),
      Boolean,
    );
    const replace = app.sessions.replace.bind(app.sessions);
    const resolve = app.bindings.resolve.bind(app.bindings);
    app.sessions.replace = (...args) => {
      app.bindings.resolve = (candidate) =>
        candidate.id === other.id
          ? Promise.resolve({ id: session.id })
          : resolve(candidate);
      return replace(...args);
    };
    const raced = await (
      await f.request(endpoint, {
        method: "POST",
        body: {
          mode: "now",
          interrupt: true,
          requestId: randomUUID(),
          targetAccountId: target.id,
        },
      })
    ).json();
    assert.equal(raced.state, "failed");
    assert.equal((await app.sessions.get(session.id)).accountId, source.id);
    assert.equal((await app.sessions.get(session.id)).status, "running");
    app.sessions.replace = replace;
    app.bindings.resolve = resolve;
    await app.sessions.stop(other.id);
    await app.sessions.remove(other.id);
    await fs.writeFile(
      capture,
      (await fs.readFile(capture, "utf8"))
        .trim()
        .split("\n")
        .filter((row) => JSON.parse(row).id === session.id)
        .join("\n") + "\n",
    );
    const body = {
      mode: "now",
      interrupt: true,
      requestId: randomUUID(),
      targetAccountId: target.id,
    };
    const result = await (await f.request(endpoint, { method: "POST", body })).json();
    assert.ok(["reloading", "completed"].includes(result.state), JSON.stringify(result));
    await until(
      async () => (await f.request(endpoint)).json(),
      (value) => value.state === "completed",
    );
    const current = await app.sessions.get(session.id);
    assert.equal(current.accountId, target.id);
    assert.equal(current.deliveryAccountId, source.id);
    const scope = JSON.stringify([session.id, source.id, tool, session.createdAt]);
    const delivery = await f.request(
      `/api/sessions/${session.id}/input/${randomUUID()}?scope=${encodeURIComponent(scope)}`,
    );
    assert.equal(delivery.status, 200);
    assert.equal((await delivery.json()).status, "absent");
    assert.equal(current.createdAt, session.createdAt);
    assert.deepEqual(current.attachments, session.attachments);
    assert.equal((await app.bindings.resolve(current)).id, session.id);
    const launches = (await fs.readFile(capture, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(launches.length, 2);
    assert.equal(launches[1].root, root(target));
    assert.equal(launches[1].id, launches[0].id);
    assert.equal(
      await fs.readFile(path.join(root(target), "auth.json"), "utf8"),
      "target credentials",
    );
    assert.equal(
      await fs.readFile(path.join(root(source), "auth.json"), "utf8"),
      "source credentials",
    );
    await f.request(endpoint, { method: "POST", body });
    assert.equal((await fs.readFile(capture, "utf8")).trim().split("\n").length, 2);
    await fs.writeFile(fail, "fail startup");
    const failed = await (
      await f.request(endpoint, {
        method: "POST",
        body: { ...body, requestId: randomUUID(), targetAccountId: source.id },
      })
    ).json();
    assert.ok(["reloading", "failed"].includes(failed.state));
    await until(
      async () => (await f.request(endpoint)).json(),
      (value) => value.state === "failed",
    );
    assert.equal((await app.sessions.get(session.id)).accountId, source.id);
    await fs.rm(fail);
    const retried = await (
      await f.request(endpoint, {
        method: "POST",
        body: { mode: "now", interrupt: true, requestId: randomUUID() },
      })
    ).json();
    assert.ok(
      ["reloading", "completed"].includes(retried.state),
      JSON.stringify(retried),
    );
    await until(
      async () => (await f.request(endpoint)).json(),
      (value) => value.state === "completed",
    );
  });
}
