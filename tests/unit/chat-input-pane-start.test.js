import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chatInputSnapshot } from "../../server/features/sessions/session-chat-input.js";

// A restarted CLI gets a new pane process inside a tmux session that may be much
// older; the startup hold must measure the process, not the tmux session.
test("the startup window starts with the pane process, not the tmux session", async (t) => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore",
  });
  t.after(() => child.kill());
  const sessionCreated = Math.floor(Date.now() / 1000) - 3600;
  const manager = {
    target: (id) => `tuiui-${id}`,
    tmux: async () => `%1|${child.pid}|${sessionCreated}|0|0|120|35|0\n> `,
  };
  const snapshot = await chatInputSnapshot(manager, {
    id: "restarted",
    accountId: "account",
    tool: "opencode",
    restartGeneration: 1,
  });
  assert.ok(
    Math.abs(Date.now() - snapshot.paneStartedAt) < 60_000,
    `pane started ${new Date(snapshot.paneStartedAt).toISOString()}`,
  );
});
