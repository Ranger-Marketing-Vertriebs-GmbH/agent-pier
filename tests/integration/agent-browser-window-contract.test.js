import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { BrowserWindowKeeper } from "../../server/features/assistants/browser-window-keeper.js";

// Opens a real, visible browser window: opt-in, like the other native contracts.
const executable = process.env.AGENTPIER_BROWSER_WINDOW_CONTRACT;
const options = {
  skip:
    !executable &&
    "set AGENTPIER_BROWSER_WINDOW_CONTRACT to a Chromium-based browser executable",
  timeout: 120000,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

function cdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(Error(msg.error.message)) : resolve(msg.result);
    }
  };
  return {
    ready: new Promise((r) => (ws.onopen = r)),
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        pending.set(++id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
      }),
    close: () => ws.close(),
  };
}

test(
  "a visible agent browser starts minimized and keeps working for the agent",
  options,
  async (t) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-window-"));
    const page = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(
        '<input id=i style="position:absolute;left:10px;top:10px;width:300px;height:40px">',
      );
    });
    await new Promise((r) => page.listen(0, "127.0.0.1", r));
    const port = await freePort();
    // OpenClaw's managed launch arguments for a visible profile (chrome-*.mjs).
    const browser = spawn(
      executable,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--password-store=basic",
        "--use-mock-keychain",
        "--no-proxy-server",
        `http://127.0.0.1:${page.address().port}/`,
      ],
      { stdio: "ignore" },
    );
    const keeper = new BrowserWindowKeeper(port);
    t.after(async () => {
      keeper.close();
      browser.kill();
      await sleep(1000);
      page.close();
      fs.rmSync(profile, { recursive: true, force: true });
    });
    assert.equal(await keeper.start(), true);
    await sleep(1500);
    // A second client, as OpenClaw's Playwright connection is one.
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const agent = cdp(version.webSocketDebuggerUrl);
    await agent.ready;
    const { targetInfos } = await agent.send("Target.getTargets");
    const target = targetInfos.find((info) => info.type === "page");
    const { bounds } = await agent.send("Browser.getWindowForTarget", {
      targetId: target.targetId,
    });
    assert.equal(bounds.windowState, "minimized");
    const { sessionId } = await agent.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    const evaluate = async (expression) =>
      (
        await agent.send(
          "Runtime.evaluate",
          { expression, returnByValue: true },
          sessionId,
        )
      ).result.value;
    assert.equal(await evaluate("document.visibilityState"), "visible");
    const shot = await agent.send("Page.captureScreenshot", { format: "png" }, sessionId);
    assert.ok(shot.data.length > 100);
    await agent.send(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x: 50, y: 30, button: "left", clickCount: 1 },
      sessionId,
    );
    await agent.send(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x: 50, y: 30, button: "left", clickCount: 1 },
      sessionId,
    );
    await agent.send("Input.insertText", { text: "agent" }, sessionId);
    assert.equal(await evaluate("document.getElementById('i').value"), "agent");
    agent.close();
  },
);
