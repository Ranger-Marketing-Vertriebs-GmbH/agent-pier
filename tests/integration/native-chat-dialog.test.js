import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { applicationFixture } from "../helpers/application.js";
import { createTuiInputRecorder } from "../helpers/tui-input-recorder.js";

for (const tool of ["codex", "opencode"]) {
  for (const afterPaste of [false, true]) {
    test(`${tool}: native dialog ${afterPaste ? "after" : "before"} paste holds delivery without answering`, async (t) => {
      const { frames } = JSON.parse(
        await fs.readFile(
          new URL(`../fixtures/tui-input/${tool}-prompt-spike.json`, import.meta.url),
          "utf8",
        ),
      );
      const f = await applicationFixture(t);
      const recorder = await createTuiInputRecorder(f, { native: { tool } });
      const account = f.application.accounts.create({ name: "Native dialog test", tool });
      const manager = f.application.sessions;
      const session = await manager.create({
        id: `dialog-${tool}`,
        name: "Owned dialog",
        tool,
        accountId: account.id,
        cwd: f.home,
        command: recorder.command,
        args: recorder.args,
        env: { HOME: f.home },
      });
      await recorder.waitForText("ready");
      f.application.requests.list = async () => ({ requests: [] });
      f.application.requests.hasPending = () => false;
      f.application.chatDelivery.retryMs = 20;
      const original = manager.tmux.bind(manager);
      let dialog = !afterPaste;
      let pasted = false;
      manager.tmux = async (args, opts) => {
        const result = await original(args, opts);
        if (args[0] === "paste-buffer" && afterPaste && !pasted) {
          dialog = true;
          pasted = true;
        }
        if (dialog && args[0] === "display-message") {
          const { raw, pane } = frames.permission;
          const metadata = result.slice(0, result.indexOf("\n")).split("|");
          metadata.splice(
            3,
            4,
            ...[pane.cursorX, pane.cursorY, pane.width, pane.height].map(String),
          );
          return metadata.join("|") + "\n" + raw;
        }
        if (dialog && args[0] === "capture-pane") return frames.permission.raw;
        return result;
      };
      const scope = JSON.stringify([session.id, account.id, tool, session.createdAt]);
      const body = {
        deliveryId: randomUUID(),
        deliveryScope: scope,
        text: "AP_PROBE_HELD_DIALOG",
        submit: true,
      };
      const endpoint = `/api/sessions/${session.id}/input`;
      const send = async () =>
        (await f.request(endpoint, { method: "POST", body })).json();
      const held = await send();
      assert.equal(held.status, "pending");
      assert.equal(held.waiting, "dialog");
      await sleep(100);
      const paste = `\x1b[200~${body.text}\x1b[201~`;
      assert.equal((await recorder.readBytes()).toString(), afterPaste ? paste : "");
      assert.equal((await send()).status, "pending");
      dialog = false;
      let status;
      for (let n = 0; n < 100; n++) {
        status = await (
          await f.request(
            `${endpoint}/${body.deliveryId}?scope=${encodeURIComponent(scope)}`,
          )
        ).json();
        if (status.status !== "pending") break;
        await sleep(25);
      }
      assert.equal(status.status, "handed-off", JSON.stringify(status));
      assert.equal((await recorder.readBytes()).toString(), paste + "\r");
      assert.equal((await send()).status, "handed-off");
      assert.equal((await recorder.readBytes()).toString(), paste + "\r");
    });
  }
}
