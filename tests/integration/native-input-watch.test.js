import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { applicationFixture } from "../helpers/application.js";
import { watchNativeInput } from "../../server/features/chat/native-input-watch.js";
import { inputHash } from "../../server/features/chat/native-input-queue.js";

const until = async (condition) => {
  const end = Date.now() + 5000;
  while (!(await condition())) {
    assert.ok(Date.now() < end, "Expected observer transition");
    await delay(20);
  }
};
test(
  "output observer leaves dimensions and input writable, streams queue changes and disposes its client",
  { timeout: 15000 },
  async (t) => {
    const fixture = await applicationFixture(t);
    const frames = JSON.parse(
      await fs.readFile(
        new URL("../fixtures/native-input-queue.json", import.meta.url),
        "utf8",
      ),
    ).codex.snapshots;
    const render = (frame) =>
      `\x1b[2J\x1b[H${frame.raw.replace(/\n$/, "").replaceAll("\n", "\r\n")}\x1b[${frame.pane.cursorY + 1};${frame.pane.cursorX + 1}H`;
    const file = path.join(fixture.home, "native-fixture.mjs");
    await fs.writeFile(
      file,
      `process.stdin.setRawMode(true); process.stdin.resume(); const frames=${JSON.stringify([render(frames.idle), render(frames.queued)])}; let n=0; process.stdout.write(frames[0]); process.stdin.on('data', () => process.stdout.write(frames[++n % 2]));`,
    );
    const manager = fixture.application.sessions;
    const session = await manager.create({
      id: "queue-observer",
      name: "Queue fixture",
      tool: "codex",
      accountId: "fixture",
      cwd: fixture.home,
      command: process.execPath,
      args: [file],
      env: { HOME: fixture.home },
    });
    const target = `${manager.target(session.id)}:0.0`;
    const size = () =>
      manager.tmux([
        "display-message",
        "-p",
        "-t",
        target,
        "#{pane_width}x#{pane_height}",
      ]);
    await until(async () =>
      (await manager.tmux(["capture-pane", "-p", "-t", target])).includes("Ask Codex"),
    );
    const before = await size();
    const events = [];
    const dispose = watchNativeInput({ sessions: manager, session }, (value) =>
      events.push(value),
    );
    t.after(dispose);
    await until(() => events.some(Boolean));
    await manager.tmux(["send-keys", "-t", target, "x"]);
    await until(() => events.at(-1)?.queue.includes(inputHash("AP_PROBE_SECOND")));
    assert.equal(await size(), before);
    await manager.tmux(["send-keys", "-t", target, "x"]);
    await until(() => events.at(-1)?.queue.length === 0);
    const last = events.length;
    dispose();
    await until(
      async () =>
        !(
          await manager.tmux([
            "list-clients",
            "-t",
            manager.target(session.id),
            "-F",
            "#{client_control_mode}",
          ])
        ).trim(),
    );
    await manager.tmux(["send-keys", "-t", target, "x"]);
    await delay(250);
    assert.equal(events.length, last);
  },
);
