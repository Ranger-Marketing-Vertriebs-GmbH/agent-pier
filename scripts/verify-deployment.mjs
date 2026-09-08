import { serverMessages } from "../server/lib/i18n/de.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { loadConfig } from "../server/lib/config.js";
const config = loadConfig();
const local = `http://127.0.0.1:${config.port}`;
const remote = config.remoteUrl;
if (!remote) throw Error(serverMessages.scripts.tailscaleUrlMissing);
const artifacts = path.resolve(".superpowers/sdd/2026-09-06-tuiui/screenshots");
fs.mkdirSync(artifacts, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tuiui-deployment-"));
const sessions = [];
const browser = await chromium.launch({
  channel: process.platform === "darwin" ? "chrome" : undefined,
});
async function api(endpoint, method = "GET", body) {
  const r = await fetch(local + "/api" + endpoint, {
    method,
    headers: { origin: local, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(data.error || r.statusText);
  return data;
}
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let outputFrames = 0;
  page.on("websocket", (ws) =>
    ws.on("framereceived", (frame) => {
      try {
        if (JSON.parse(frame.payload).type === "output") outputFrames++;
      } catch {}
    }),
  );
  const response = await page.goto(remote);
  assert.equal(response.status(), 200);
  await page
    .getByRole("heading", { name: serverMessages.scripts.deploymentHeading })
    .waitFor();
  await page.screenshot({
    path: path.join(artifacts, "deployed-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
  const state = await api("/state");
  const checks = [];
  for (const tool of state.tools.filter((t) => t.installed)) {
    const session = await api("/sessions", "POST", {
      name: serverMessages.scripts.browserCheckName(tool.name),
      accountId: `local-${tool.id}`,
      cwd: temp,
    });
    sessions.push(session.id);
    const previous = outputFrames;
    await page.goto(remote + "/#" + session.id);
    await page.getByRole("heading", { name: session.name, exact: true }).waitFor();
    const until = Date.now() + 15000;
    while (outputFrames <= previous && Date.now() < until)
      await new Promise((r) => setTimeout(r, 100));
    assert.ok(outputFrames > previous, `${tool.id}: WSS output missing`);
    let screen = "";
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      screen = (await api(`/sessions/${session.id}/screen`)).text;
      if (/Codex|OpenAI|Claude|trust|Welcome/i.test(screen)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(screen.trim());
    await page.screenshot({
      path: path.join(artifacts, `native-${tool.id}-desktop.png`),
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Lesemodus", exact: true }).click();
    await page.getByLabel("Chatverlauf").waitFor();
    await page.screenshot({
      path: path.join(artifacts, `native-${tool.id}-mobile.png`),
      fullPage: true,
      animations: "disabled",
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.reload();
    await page.getByRole("heading", { name: session.name, exact: true }).waitFor();
    assert.equal(
      (await api("/state")).sessions.find((s) => s.id === session.id).status,
      "running",
    );
    checks.push({
      tool: tool.id,
      remoteTUI: true,
      secureWebSocket: true,
      mobile: true,
      reloadSurvival: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await api(`/sessions/${session.id}/stop`, "POST");
    await api(`/sessions/${session.id}`, "DELETE");
    sessions.splice(sessions.indexOf(session.id), 1);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ url: remote, pageErrors: errors, checks }, null, 2));
} finally {
  for (const id of sessions) {
    await api(`/sessions/${id}/stop`, "POST").catch(() => {});
    await api(`/sessions/${id}`, "DELETE").catch(() => {});
  }
  await browser.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
