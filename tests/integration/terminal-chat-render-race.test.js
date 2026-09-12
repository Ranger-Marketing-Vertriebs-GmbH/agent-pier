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
test("delayed terminal rendering cannot merge an unsent draft with chat", async () => {
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
    if(c==='\\r') fs.writeFileSync(${JSON.stringify(output)},JSON.stringify(draft));
    else draft+=c;
  }
  clearTimeout(render);
  render=setTimeout(()=>{
    process.stdout.write('\\x1b[${fixture.pane.cursorY + 1};1H\\x1b[K\\x1b[1m›\\x1b[0m '+draft);
  },700);
});
process.stdout.write(${JSON.stringify(screen)});
fs.writeFileSync(${JSON.stringify(ready)},'ready');
`,
  );
  const manager = new SessionManager({ dataDir: root });
  try {
    const session = await manager.create({
      id: "race",
      name: "Synthetic audit",
      accountId: "synthetic",
      tool: "codex",
      cwd: root,
      command: process.execPath,
      args: [script],
    });
    for (let n = 0; n < 100; n++) {
      if (
        await fs.access(ready).then(
          () => true,
          () => false,
        )
      )
        break;
      await sleep(20);
    }
    const client = await manager.attach(session.id);
    await sleep(100);
    await client.write("UNSENT TERMINAL DRAFT");
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
    const result = await delivery.send(session.id, {
      deliveryId: randomUUID(),
      deliveryScope: scope,
      text: "CHAT PROMPT",
      submit: true,
    });
    assert.equal(result.status, "rejected");
    await sleep(900);
    assert.equal(
      await fs.access(output).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.match(await manager.screen(session.id), /UNSENT TERMINAL DRAFT/);
    await client.write("\r");
    assert.equal(manager.pendingTerminalInput.has(session.id), false);
  } finally {
    await manager.close();
    await manager.tmux(["kill-server"]).catch(() => {});
    await fs.rm(path.dirname(manager.socketPath), {
      recursive: true,
      force: true,
    });
    await fs.rm(root, { recursive: true, force: true });
  }
});
