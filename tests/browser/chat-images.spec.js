import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzN8AAAAASUVORK5CYII=",
  "base64",
);
const first = "a".repeat(64),
  second = "b".repeat(64),
  missing = "c".repeat(64);
async function fixture(page, large = false) {
  const imageBody = large
    ? Buffer.from(
        await page.evaluate(() => {
          const canvas = document.createElement("canvas");
          canvas.width = 2400;
          canvas.height = 1400;
          const context = canvas.getContext("2d");
          context.fillStyle = "#101114";
          context.fillRect(0, 0, 2400, 1400);
          context.fillStyle = "#f49a58";
          context.font = "bold 130px sans-serif";
          context.fillText("CLI image output", 180, 260);
          context.strokeStyle = "#f49a58";
          context.lineWidth = 22;
          context.beginPath();
          context.moveTo(180, 1120);
          context.lineTo(600, 900);
          context.lineTo(1100, 1020);
          context.lineTo(1580, 640);
          context.lineTo(2200, 400);
          context.stroke();
          return canvas.toDataURL("image/png").split(",")[1];
        }),
        "base64",
      )
    : png;
  const session = {
    id: "image-session",
    name: "CLI-Bildausgaben",
    tool: "codex",
    accountId: "local-codex",
    cwd: "/fixture/project",
    status: "running",
  };
  const item = (id, path) => ({
    id,
    path,
    url: `/api/sessions/image-session/chat/images/${id}`,
  });
  // The server only describes images whose files exist, so a mention of a file
  // written later carries no image until the chat refreshes after the write.
  let created = false;
  const messages = () => [
    {
      id: "m1",
      role: "assistant",
      text: "Das Ergebnis:\n\n![Vorschau](/fixture/generated/result.png)\n\nWeitere Datei: ./output.png",
      images: [
        item(first, "/fixture/generated/result.png"),
        item(second, "./output.png"),
      ],
    },
    {
      id: "missing-answer",
      role: "assistant",
      toolName: "Render",
      status: "completed",
      text: "/fixture/missing.png",
      images: created ? [item(missing, "/fixture/missing.png")] : [],
    },
    {
      id: "internal",
      role: "tool",
      toolName: "Command",
      status: "completed",
      text: "${directory}/pending.png ...png pending.png",
      images: [item("d".repeat(64), "${directory}/pending.png")],
    },
    {
      id: "external",
      role: "assistant",
      text: "![Extern](https://external.invalid/image.png)",
      images: [],
    },
  ];
  const snapshot = () => ({
    availability: "ready",
    providerSessionId: "native",
    messages: messages(),
    tasks: [],
  });
  const publish = await mockChatStream(page, snapshot);
  const imageRequests = [];
  let unavailable = new Set();
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/chat/images/")) {
      imageRequests.push(url.pathname);
      return route.fulfill(
        unavailable.has(url.pathname.split("/").at(-1))
          ? { status: 404, json: { error: "Bild fehlt" } }
          : { contentType: "image/png", body: imageBody },
      );
    }
    if (url.pathname === "/api/state")
      return route.fulfill({
        json: {
          tools: [{ id: "codex", name: "Codex", installed: true }],
          accounts: [{ id: "local-codex", tool: "codex", name: "Lokal", kind: "local" }],
          sessions: [session],
          home: "/fixture",
        },
      });
    if (url.pathname.endsWith("/chat")) return route.fulfill({ json: snapshot() });
    return route.fulfill({ json: { supported: false, phase: "idle" } });
  });
  await page.routeWebSocket("**/api/sessions/*/terminal", (ws) =>
    ws.send(JSON.stringify({ type: "output", data: "CLI output" })),
  );
  return {
    imageRequests,
    createMissing: () => {
      created = true;
      publish();
    },
    setUnavailable: (ids) => {
      unavailable = new Set(ids);
    },
  };
}
const imageRequestsFor = (f, id) =>
  f.imageRequests.filter((url) => url.endsWith(id)).length;
async function open(page) {
  await page.goto(base + "/#image-session");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
}
test("reader renders local raster previews from assistant messages while retaining paths", async ({
  page,
}) => {
  const { imageRequests } = await fixture(page);
  await open(page);
  const thumbnail = page.getByRole("img", {
    name: "Bildvorschau: /fixture/generated/result.png",
    exact: true,
  });
  await expect(thumbnail).toBeVisible();
  await expect(thumbnail).toHaveJSProperty("naturalWidth", 1);
  await expect(
    page.locator(".chat-image-path").filter({ hasText: "/fixture/generated/result.png" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Bild öffnen: /fixture/generated/result.png" })
    .click();
  await expect(page.getByRole("dialog", { name: "Bildansicht" })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("img")).toHaveJSProperty(
    "naturalWidth",
    1,
  );
  await page.getByRole("button", { name: "Bildansicht schließen" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("img", { name: "Extern", exact: true })).toHaveCount(0);
  expect(
    imageRequests.every((url) =>
      url.startsWith("/api/sessions/image-session/chat/images/"),
    ),
  ).toBeTruthy();
});
test("a mentioned image without a file stays plain text until the file exists and the chat refreshes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page);
  await open(page);
  const mention = page.getByText("/fixture/missing.png", { exact: true });
  await mention.scrollIntoViewIfNeeded();
  await expect(mention).toBeVisible();
  const card = page
    .locator(".chat-image-card")
    .filter({ hasText: "/fixture/missing.png" });
  await expect(card).toHaveCount(0);
  await expect(page.getByText("Bild nicht verfügbar")).toHaveCount(0);
  expect(imageRequestsFor(f, missing)).toBe(0);
  f.createMissing();
  await expect(card.getByRole("img")).toHaveJSProperty("naturalWidth", 1);
  await expect(card).not.toContainText("Bild nicht verfügbar");
});
test("an image deleted after it was found keeps a readable path and can retry", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page);
  f.setUnavailable([second]);
  await open(page);
  const card = page.locator(".chat-image-card").filter({ hasText: "./output.png" });
  await card.scrollIntoViewIfNeeded();
  await expect(card).toContainText("Bild nicht verfügbar");
  expect((await card.locator(".chat-image-open").boundingBox()).height).toBeLessThan(80);
  await expect(page.locator(".chat-tool")).not.toHaveAttribute("open", "");
  f.setUnavailable([]);
  await card.getByRole("button", { name: "Bild erneut laden" }).click();
  await expect(card.getByRole("img")).toHaveJSProperty("naturalWidth", 1);
});
test("mobile image previews and full view fit without horizontal overflow", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, true);
  await open(page);
  const button = page.getByRole("button", {
    name: "Bild öffnen: /fixture/generated/result.png",
  });
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeEnabled();
  await expect(button.getByRole("img")).toHaveJSProperty("naturalWidth", 2400);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
  await button.click();
  const dialog = page.getByRole("dialog", { name: "Bildansicht" });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(391);
  // The image viewer keeps its own centred layout instead of the generic bottom sheet.
  expect(Math.round(box.x)).toBe(10);
  expect(Math.round(box.width)).toBe(370);
  expect(Math.abs(box.y - (844 - box.y - box.height))).toBeLessThanOrEqual(1);
  expect(await dialog.evaluate((element) => getComputedStyle(element).top)).toBe("0px");
  await page.screenshot({
    path: testInfo.outputPath("local-image-mobile.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("tool image descriptors never load previews, even when the tool details are opened", async ({
  page,
}) => {
  const { imageRequests } = await fixture(page);
  await open(page);
  await page.locator(".chat-tool-group > summary").click();
  const tool = page.locator(".chat-tool");
  await tool.scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", {
      name: "Bild öffnen: ${directory}/pending.png",
      exact: true,
    }),
  ).toHaveCount(0);
  await tool.locator("summary").click();
  await expect(tool.locator("pre")).toContainText("${directory}/pending.png");
  await expect(tool.getByRole("img")).toHaveCount(0);
  expect(imageRequests.some((url) => url.endsWith("d".repeat(64)))).toBe(false);
});
