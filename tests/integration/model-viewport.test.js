import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { applicationFixture } from "../helpers/application.js";
import { createTuiInputRecorder } from "../helpers/tui-input-recorder.js";
import { watchNativeInput } from "../../server/features/chat/native-input-watch.js";

async function waitFor(read, predicate) {
  for (let n = 0; n < 100; n++) {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(20);
  }
  assert.fail("The isolated terminal did not reach its expected state");
}

test("Claude chat restores room for the picker after a mobile terminal detaches and preserves attached sizing", async (t) => {
  const fixture = await applicationFixture(t);
  const manager = fixture.application.sessions;
  const recorder = await createTuiInputRecorder(fixture, {
    screen: "Claude Code\r\n❯ draft\r\n? for shortcuts\r\n",
  });
  const session = await manager.create({
    id: "model-viewport",
    name: "Model viewport",
    tool: "claude",
    accountId: "local-claude",
    cwd: fixture.home,
    command: recorder.command,
    args: recorder.args,
    env: { HOME: fixture.home },
  });
  await recorder.waitForText("ready");
  const target = `${manager.target(session.id)}:0.0`;
  const geometry = async () =>
    (
      await manager.tmux([
        "display-message",
        "-p",
        "-t",
        target,
        "#{window_width} #{window_height} #{session_attached}",
      ])
    )
      .trim()
      .split(" ")
      .map(Number);
  const sizing = () => manager.tmux(["show-options", "-w", "-t", target, "window-size"]);
  const originalSizing = await sizing();
  const mobile = await manager.attach(session.id, { cols: 43, rows: 31 });
  await waitFor(geometry, ([width, , attached]) => width === 43 && attached === 1);
  mobile.dispose();
  await waitFor(geometry, ([, , attached]) => attached === 0);
  const stopWatching = watchNativeInput({ sessions: manager, session }, () => {});
  t.after(stopWatching);
  await waitFor(geometry, ([, , attached]) => attached === 1);
  fixture.application.models.timeout = 200;
  await fixture.application.models.open(session.id);
  const [width, height] = await geometry();
  assert.ok(
    width >= 120 && height >= 50,
    `picker was left clipped at ${width}x${height}`,
  );
  assert.equal(
    await sizing(),
    originalSizing,
    "automatic terminal sizing must be restored",
  );
  assert.equal((await recorder.readBytes()).toString(), "\x1bp");

  const attached = await manager.attach(session.id, { cols: 43, rows: 31 });
  t.after(() => attached.dispose());
  await waitFor(
    geometry,
    ([width, height, attached]) => width === 43 && height === 31 && attached === 2,
  );
  await fixture.application.models.open(session.id);
  assert.deepEqual(
    await geometry(),
    [43, 31, 2],
    "an open terminal must retain its display size",
  );
  assert.equal(await sizing(), originalSizing);
  assert.equal((await recorder.readBytes()).toString(), "\x1bp\x1bp");
});
