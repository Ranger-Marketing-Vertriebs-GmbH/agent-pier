import { navigateTo } from "../helpers/navigation.js";
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createApplication } from "../../server/app.js";
let application, dir, url, token;
test.beforeAll(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tuiui-browser-")));
  application = await createApplication({ dataDir: dir, home: dir, port: 0 });
  await new Promise((r) => application.server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${application.server.address().port}`;
  token = await application.login.setup({
    username: "live-fixture",
    password: randomUUID(),
  });
});
test.beforeEach(async ({ context }) => {
  await context.addCookies([
    { name: "agentpier_session", value: token, url, httpOnly: true, sameSite: "Strict" },
  ]);
});
test.afterAll(async () => {
  for (const s of await application.sessions.list())
    await application.sessions.stop(s.id);
  await application.close();
  try {
    execFileSync("tmux", ["-S", application.sessions.socketPath, "kill-server"], {
      stdio: "ignore",
    });
  } catch {}
  fs.rmSync(path.dirname(application.sessions.socketPath), {
    recursive: true,
    force: true,
  });
  fs.rmSync(dir, { recursive: true, force: true });
});
async function chatFixture(id, name, counter = false) {
  const nativeId = randomUUID();
  const root = path.join(dir, ".claude", "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, nativeId + ".jsonl");
  const script = `const fs=require('node:fs'),readline=require('node:readline');let count=0;const file=process.argv[1],sessionId=process.argv[2],cwd=process.cwd();function message(type,text){fs.appendFileSync(file,JSON.stringify({type,uuid:require('node:crypto').randomUUID(),sessionId,cwd,message:{role:type,content:text}})+'\\n');}message('assistant','REAL_PTY_READY');process.stdout.write('\\x1b[32mREAL_PTY_READY\\x1b[0m\\nÄnderungen · ❯ ● ▐▛███▜▌\\nTUI_STATUS_ONLY\\n');readline.createInterface({input:process.stdin}).on('line',line=>{count++;message('user',line);const text=${counter}?'COUNTER:'+count:'RECEIVED:'+line;message('assistant',text);process.stdout.write(text+'\\n');});`;
  const session = await application.sessions.create({
    id,
    accountId: "local-claude",
    tool: "claude",
    name,
    cwd: dir,
    command: process.execPath,
    args: ["-e", script, file, nativeId],
    env: { HOME: dir, PATH: "/bin:/usr/bin" },
  });
  application.chat.initialize(session, nativeId);
  return session;
}
test("live backend account save and real terminal compose, resize and reconnect", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await expect(
    page.getByRole("heading", { name: "Dein Terminal. Überall." }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/live-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await navigateTo(page, "Konten");
  await page.getByRole("button", { name: "Konto hinzufügen" }).click();
  await page.getByLabel("Kontoname").fill("Browser Test");
  await page.getByRole("button", { name: "Konto erstellen", exact: true }).click();
  await expect(page.getByText("Browser Test", { exact: true })).toBeVisible();
  expect(application.accounts.list().some((a) => a.name === "Browser Test")).toBe(true);
  await chatFixture("browser-terminal", "Terminal Integration");
  await page.goto(url + "/#browser-terminal");
  await expect(
    page.getByRole("heading", { name: "Terminal Integration", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByLabel("Chatverlauf")).toContainText("REAL_PTY_READY");
  await expect(page.getByLabel("Chatverlauf")).not.toContainText("TUI_STATUS_ONLY");
  await page
    .getByRole("textbox", { name: "Nachricht", exact: true })
    .fill("browser message");
  await page.getByRole("button", { name: "Senden", exact: true }).click();
  await expect
    .poll(async () => application.sessions.screen("browser-terminal"))
    .toContain("RECEIVED:browser message");
  await page.reload();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByLabel("Chatverlauf")).toContainText("RECEIVED:browser message");
  expect((await application.sessions.get("browser-terminal")).status).toBe("running");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/live-mobile-reader.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.getByLabel("Interaktives Terminal")).toBeVisible();
  await page.screenshot({
    path: "test-results/live-mobile-terminal.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(errors).toEqual([]);
});
test("browser reconnects after HTTP service restart while CLI memory remains alive", async ({
  page,
}) => {
  await chatFixture("browser-restart", "Restart Integration", true);
  await page.goto(url + "/#browser-restart");
  await expect(
    page.getByRole("heading", { name: "Restart Integration", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("textbox", { name: "Nachricht", exact: true }).fill("first");
  await page.getByRole("button", { name: "Senden", exact: true }).click();
  await expect
    .poll(() => application.sessions.screen("browser-restart"))
    .toContain("COUNTER:1");
  const port = application.server.address().port;
  const closing = Date.now();
  await application.close();
  expect(Date.now() - closing).toBeLessThan(10000);
  application = await createApplication({ dataDir: dir, home: dir, port });
  await new Promise((r) => application.server.listen(port, "127.0.0.1", r));
  await expect(page.getByText("Verbunden", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await page.getByRole("textbox", { name: "Nachricht", exact: true }).fill("second");
  await page.getByRole("button", { name: "Senden", exact: true }).click();
  await expect
    .poll(() => application.sessions.screen("browser-restart"))
    .toContain("COUNTER:2");
});
test("a user can open the workspace from an external link without weakening API origin checks", async ({
  page,
}) => {
  await page.route("https://tuiui-link-test.invalid/", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><meta charset="utf-8"><a href="${url}/">Open workspace</a>`,
    }),
  );
  await page.goto("https://tuiui-link-test.invalid/");
  const [response] = await Promise.all([
    page.waitForResponse((response) => response.url() === url + "/"),
    page.getByRole("link", { name: "Open workspace" }).click(),
  ]);
  expect(response.status()).toBe(200);
  // Fetch Metadata is covered directly in security.test.js; interception may omit it from CDP headers.
  await expect(
    page.getByRole("heading", { name: "Dein Terminal. Überall." }),
  ).toBeVisible();
});
