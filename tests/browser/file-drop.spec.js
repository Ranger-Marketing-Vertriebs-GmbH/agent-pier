import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

async function fixture(
  page,
  {
    reject = false,
    uploadWait,
    failOnce = false,
    storedPath = "/fixture/files/design notes.txt",
  } = {},
) {
  const inputs = [],
    uploads = [];
  const session = {
    id: "drop-demo",
    name: "Drop demo",
    tool: "claude",
    accountId: "local-claude",
    cwd: "/fixture",
    status: "running",
  };
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let json = {};
    if (pathname === "/api/state")
      json = {
        tools: [{ id: "claude", name: "Claude Code", installed: true }],
        accounts: [{ id: "local-claude", name: "Claude", tool: "claude", kind: "local" }],
        sessions: [session],
        home: "/fixture",
      };
    else if (pathname.endsWith("/chat/attachments")) {
      uploads.push(route.request().postDataBuffer());
      if (uploadWait) await uploadWait;
      if (reject || (failOnce && uploads.length === 1))
        return route.fulfill({ status: 500, json: { error: "Upload failed fixture" } });
      json = { name: "design notes.txt", path: storedPath };
    } else if (pathname.endsWith("/chat"))
      json = { availability: "ready", messages: [], tasks: [] };
    await route.fulfill({ json });
  });
  await page.routeWebSocket("**/api/sessions/*/terminal", (socket) => {
    socket.onMessage((message) => {
      const value = JSON.parse(message);
      if (value.type === "input") inputs.push(value.data);
    });
    socket.send(JSON.stringify({ type: "output", data: "Ready > " }));
  });
  await page.goto(baseURL + "/sessions/drop-demo/terminal");
  await expect(page.locator(".connection")).toHaveText("Verbunden");
  return { inputs, uploads };
}
async function transfer(page) {
  return page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(["hello"], "design notes.txt", { type: "text/plain" }));
    return data;
  });
}

test("desktop terminal drop uploads a file and inserts a quoted path without submitting", async ({
  page,
}) => {
  const state = await fixture(page);
  const dataTransfer = await transfer(page);
  const pane = page.locator(".terminal-pane");
  await pane.dispatchEvent("dragover", { dataTransfer });
  await expect(pane).toHaveAttribute("data-dropping", "true");
  await page.screenshot({ path: ".cache/terminal-file-drop-desktop.png" });
  await pane.dispatchEvent("drop", { dataTransfer });
  await expect.poll(() => state.uploads.length).toBe(1);
  await expect
    .poll(() => state.inputs.join(""))
    .toBe("'/fixture/files/design notes.txt' ");
  await expect(pane).not.toHaveAttribute("data-dropping", "true");
  expect(state.inputs.join("")).not.toMatch(/[\r\n]/);
});

test("failed terminal drop reports the upload error and sends no terminal input", async ({
  page,
}) => {
  const state = await fixture(page, { reject: true });
  await page
    .locator(".terminal-pane")
    .dispatchEvent("drop", { dataTransfer: await transfer(page) });
  await expect(page.getByRole("alert")).toContainText("Upload failed fixture");
  expect(state.inputs).toEqual([]);
});

test("touch-only devices do not show a terminal drop area or upload on drop", async ({
  browser,
}) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 390, height: 844 },
    storageState: `.cache/browser-auth-${new URL(baseURL).port}.json`,
  });
  const page = await context.newPage();
  try {
    const state = await fixture(page);
    const pane = page.locator(".terminal-pane");
    const dataTransfer = await transfer(page);
    await pane.dispatchEvent("dragover", { dataTransfer });
    await expect(pane).not.toHaveAttribute("data-dropping", "true");
    await pane.dispatchEvent("drop", { dataTransfer });
    await page.waitForTimeout(150);
    expect(state.uploads).toEqual([]);
  } finally {
    await context.close();
  }
});

test("leaving the terminal during an upload never inserts its path later", async ({
  page,
}) => {
  let release;
  const uploadWait = new Promise((resolve) => {
    release = resolve;
  });
  const state = await fixture(page, { uploadWait });
  try {
    await page
      .locator(".terminal-pane")
      .dispatchEvent("drop", { dataTransfer: await transfer(page) });
    await expect.poll(() => state.uploads.length).toBe(1);
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.locator(".terminal-pane")).toHaveCount(0);
  } finally {
    release();
  }
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".connection")).toHaveText("Verbunden");
  expect(state.inputs).toEqual([]);
});

test("cancelled desktop drags clear the chat overlay without uploading", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.locator('input[type="file"]')).toBeEnabled();
  const panel = page.locator(".chat-main");
  await panel.dispatchEvent("dragover", { dataTransfer: await transfer(page) });
  await expect(panel).toHaveAttribute("data-dropping", "true");
  await page.evaluate(() => window.dispatchEvent(new Event("dragend")));
  await expect(panel).not.toHaveAttribute("data-dropping", "true");
  expect(state.uploads).toEqual([]);
});

test("retrying a failed upload inserts an apostrophe-containing path once", async ({
  page,
}) => {
  const state = await fixture(page, {
    failOnce: true,
    storedPath: "/fixture/files/team's notes.txt",
  });
  await page
    .locator(".terminal-pane")
    .dispatchEvent("drop", { dataTransfer: await transfer(page) });
  await expect(page.getByRole("alert")).toContainText("Upload failed fixture");
  expect(state.inputs).toEqual([]);
  await page.getByRole("button", { name: "Erneut hochladen", exact: true }).click();
  await expect.poll(() => state.uploads.length).toBe(2);
  await expect
    .poll(() => state.inputs.join(""))
    .toBe("'/fixture/files/team'\\''s notes.txt' ");
  await expect(page.getByRole("alert")).toHaveCount(0);
});
