import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
const { SessionManager } = await import(
  new URL("../../server/features/sessions/session-manager.js", import.meta.url)
);
const { ChatDelivery } = await import(
  new URL("../../server/features/chat/chat-delivery.js", import.meta.url)
);
import { randomUUID } from "node:crypto";

const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

// A synthetic Codex TUI that consumes typed bytes immediately but renders its draft
// only after the test creates the release file. Rendering is gated on the test's
// progress instead of a timer, so a slow runner cannot reveal the draft early.
async function delayedRenderSession(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-audit-terminal-race-"));
  const fixture = JSON.parse(
    await fs.readFile(
      new URL("../fixtures/tui-input/codex-idle.json", import.meta.url),
      "utf8",
    ),
  );
  const rows = fixture.raw.split("\n").slice(0, fixture.pane.height);
  const screen =
    "\x1b[?2004h\x1b[2J" +
    rows.map((line, i) => `\x1b[${i + 1};1H${line}`).join("") +
    `\x1b[${fixture.pane.cursorY + 1};${fixture.pane.cursorX + 1}H`;
  const output = path.join(root, "submissions.json");
  const ready = path.join(root, "ready");
  const release = path.join(root, "release");
  const script = path.join(root, "native-fixture.mjs");
  await fs.writeFile(
    script,
    `import fs from 'node:fs';
process.stdin.setRawMode(true);
let draft='';
let render;
process.stdin.on('data', data => {
  // A loaded TUI can consume bytes before its next render.
  const value=data.toString().replaceAll('\\x1b[200~','').replaceAll('\\x1b[201~','');
  for(const c of value) {
    if(c==='\\r') { fs.writeFileSync(${JSON.stringify(output)},JSON.stringify(draft)); draft=''; }
    else if(c==='\\x15') draft='';
    else if(c==='\\x05') {}
    else if(c==='\\x7f') draft=draft.slice(0,-1);
    else draft+=c;
  }
  clearInterval(render);
  const paint=()=>{
    if(!fs.existsSync(${JSON.stringify(release)})) return false;
    process.stdout.write('\\x1b[${fixture.pane.cursorY + 1};1H\\x1b[K\\x1b[1m›\\x1b[0m '+(draft || '\\x1b[2mAsk Codex to do anything\\x1b[0m')+'\\x1b[${fixture.pane.cursorY + 1};'+(3+draft.length)+'H');
    return true;
  };
  render=setInterval(()=>{ if(paint()) clearInterval(render); },20);
});
process.stdout.write(${JSON.stringify(screen)});
fs.writeFileSync(${JSON.stringify(ready)},'ready');
`,
  );
  const manager = new SessionManager({ dataDir: root });
  t.after(async () => {
    await manager.close();
    await manager.tmux(["kill-server"]).catch(() => {});
    await fs.rm(path.dirname(manager.socketPath), {
      recursive: true,
      force: true,
    });
    await fs.rm(root, { recursive: true, force: true });
  });
  const session = await manager.create({
    id: "race",
    name: "Synthetic audit",
    accountId: "synthetic",
    tool: "codex",
    cwd: root,
    command: process.execPath,
    args: [script],
  });
  for (let n = 0; n < 100 && !(await exists(ready)); n++) await sleep(20);
  const client = await manager.attach(session.id);
  await sleep(100);
  const delivery = new ChatDelivery({
    dataDir: root,
    sessions: manager,
    requests: { list: async () => ({ requests: [] }), hasPending: () => false },
    models: { guardInput: () => {} },
  });
  const scope = JSON.stringify([
    session.id,
    session.accountId,
    session.tool,
    session.createdAt,
  ]);
  return {
    manager,
    session,
    client,
    output,
    send: (text) =>
      delivery.send(session.id, {
        deliveryId: randomUUID(),
        deliveryScope: scope,
        text,
        submit: true,
      }),
    async releaseDraft(pattern) {
      await fs.writeFile(release, "release");
      let visible = "";
      for (let n = 0; n < 250 && !pattern.test(visible); n++) {
        visible = await manager.screen(session.id);
        if (!pattern.test(visible)) await sleep(20);
      }
      assert.match(visible, pattern);
      return visible;
    },
  };
}

test("an unrendered paste never receives a blind Enter", async (t) => {
  const f = await delayedRenderSession(t);
  await f.client.write("UNSENT TERMINAL DRAFT");
  const result = await f.send("CHAT PROMPT");
  assert.equal(result.status, "uncertain");
  assert.equal(result.reason, "CHAT_SUBMIT_UNCONFIRMED");
  assert.equal(await exists(f.output), false);
  assert.equal(f.manager.pendingTerminalInput.has(f.session.id), false);
});

test("a rendered Codex draft is replaced before the chat message is sent", async (t) => {
  // The responsive native fixture applies the validated clear keys.
  const f = await delayedRenderSession(t);
  await f.client.write("VISIBLE DRAFT");
  await f.releaseDraft(/VISIBLE DRAFT/);
  assert.equal((await f.send("CHAT PROMPT")).status, "handed-off");
  for (let n = 0; n < 250 && !(await exists(f.output)); n++) await sleep(20);
  assert.equal(JSON.parse(await fs.readFile(f.output, "utf8")), "CHAT PROMPT");
});
