import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture, emit } from "../helpers/assistant-chat-fixture.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const csv = "a,b\n1,2\n";
const turn = [
  { id: "question", role: "user", text: "Send me the chart and the data.", timestamp: 1 },
];
const reply = { id: "answer", role: "assistant", text: "Both are above.", timestamp: 5 };
// Files the agent shared, as the history serves them (AgentAttachments.sharedFor).
const image = {
  id: "shared-file:img",
  role: "assistant",
  text: "The weekly chart",
  timestamp: 2,
  runId: null,
  shared: true,
  attachments: [
    { id: "img", name: "chart.png", type: "image/png", kind: "image", size: png.length },
  ],
};
const data = {
  id: "shared-file:csv",
  role: "assistant",
  text: "",
  timestamp: 3,
  runId: null,
  shared: true,
  attachments: [
    {
      id: "csv",
      name: "data.csv",
      type: "application/octet-stream",
      kind: "file",
      size: csv.length,
    },
  ],
};
const memberFile = {
  id: "shared-file:notes",
  role: "assistant",
  text: "",
  timestamp: 4,
  runId: null,
  shared: true,
  from: "Scout",
  attachments: [
    {
      id: "notes",
      name: "notes.md",
      type: "application/octet-stream",
      kind: "file",
      size: 9,
    },
  ],
};

async function sharedFixture(page) {
  const histories = {
    dinner: [...turn],
    other: [{ id: "hello", role: "assistant", text: "Another chat." }],
  };
  const state = await chatFixture(page, {
    assistants: [chatAssistant(), chatAssistant({ id: "lead", name: "Chief of Staff" })],
    conversations: [
      { id: "dinner", assistantId: "home" },
      { id: "other", assistantId: "lead" },
    ],
  });
  const network = { offline: false };
  await page.route(/\/api\/assistant-conversations\/[^/]+\/messages$/, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const id = new URL(route.request().url()).pathname.split("/")[3];
    return route.fulfill({
      json: { messages: histories[id] || [], requests: [], stale: false },
    });
  });
  // The signed-in route as the server answers it: images inline, other files only
  // as a sandboxed download.
  await page.route(/\/api\/assistant-attachments\//, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    if (id === "img")
      return route.fulfill({
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-disposition": "inline",
          "x-content-type-options": "nosniff",
        },
        body: png,
      });
    return route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${id === "csv" ? "data.csv" : "notes.md"}`,
        "content-security-policy": "default-src 'none'; sandbox",
      },
      body: id === "csv" ? csv : "# Notes\n",
    });
  });
  // The owner's delete: the file's message then says it is gone.
  const deleted = [];
  await page.route(/\/api\/assistant-conversations\/[^/]+\/shared-files\//, (route) => {
    const [, , , conversation, , file] = new URL(route.request().url()).pathname.split(
      "/",
    );
    deleted.push([route.request().method(), conversation, file]);
    histories[conversation] = histories[conversation].map((m) =>
      m.attachments?.some((x) => x.id === file)
        ? { ...m, attachments: [], unavailable: true }
        : m,
    );
    return route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/**", (route) =>
    network.offline ? route.abort("internetdisconnected") : route.fallback(),
  );
  return { state, histories, network, deleted };
}

test("files the agent shares appear in the open chat, download, and stay while offline", async ({
  page,
}) => {
  const { histories, network } = await sharedFixture(page);
  await page.goto(baseURL + "/agents/home/chats/dinner");
  const log = page.getByRole("log");
  await expect(log.getByText("Send me the chart and the data.")).toBeVisible();
  await expect(log.getByRole("list", { name: "Shared files" })).toHaveCount(0);

  // The share arrives while the chat is open: the change event refreshes it.
  histories.dinner = [...turn, image, data, memberFile, reply];
  await emit(page, { type: "change" });
  const shared = log.getByRole("list", { name: "Shared files" });
  await expect(shared).toHaveCount(3);
  const thumbnail = log.getByRole("img", { name: "chart.png" });
  await expect(thumbnail).toBeVisible();
  await expect
    .poll(() => thumbnail.evaluate((img) => img.complete && img.naturalWidth))
    .toBe(1);
  // The image opens in the in-app viewer, never by navigating to it.
  await log.getByRole("button", { name: "Open chart.png" }).click();
  const viewer = page.getByRole("dialog", { name: "Image viewer" });
  await expect(viewer.getByRole("img", { name: "chart.png" })).toHaveAttribute(
    "src",
    "/api/assistant-attachments/img",
  );
  await viewer.getByRole("button", { name: "Close image viewer" }).click();
  await expect(viewer).toHaveCount(0);
  await expect(log.getByText("The weekly chart")).toBeVisible();
  // A member's file in its lead's chat carries the member's name.
  await expect(
    log.locator("article").filter({ hasText: "notes.md" }).getByText("Scout"),
  ).toBeAttached();

  const download = page.waitForEvent("download");
  await log.getByRole("link", { name: "Download data.csv" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("data.csv");
  // Chromium cancels a download whose response a test route fulfills, so the bytes
  // are read through the same link instead.
  const link = await log
    .getByRole("link", { name: "Download data.csv" })
    .getAttribute("href");
  expect(link).toBe("/api/assistant-attachments/csv");
  expect(await page.evaluate((href) => fetch(href).then((r) => r.text()), link)).toBe(
    csv,
  );

  // Offline, the chat reopens from its last read with the shared files.
  await page.getByRole("button", { name: /^Chief of Staff, / }).click();
  await expect(page.getByText("Another chat.")).toBeVisible();
  network.offline = true;
  await page.evaluate(() => {
    window.dispatchEvent(new Event("offline"));
    window.assistantTestStream.onerror?.();
  });
  await page.getByRole("button", { name: /^Home assistant, / }).click();
  await expect(page).toHaveURL(/\/agents\/home\/chats\/dinner$/);
  await expect(log.getByRole("link", { name: "Download data.csv" })).toBeVisible();
  await expect(log.getByRole("button", { name: "Open chart.png" })).toBeVisible();
  await expect(log.getByText("The weekly chart")).toBeVisible();
});

test("a shared file no longer stored says so", async ({ page }) => {
  const { histories } = await sharedFixture(page);
  histories.dinner = [
    ...turn,
    { ...image, attachments: [], unavailable: true, text: "" },
    reply,
  ];
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(
    page.getByRole("log").getByText("This shared file is no longer available."),
  ).toBeVisible();
});

test("the owner deletes a shared file after confirming", async ({ page }) => {
  const { histories, deleted } = await sharedFixture(page);
  histories.dinner = [...turn, image, reply];
  await page.goto(baseURL + "/agents/home/chats/dinner");
  const log = page.getByRole("log");
  await log.getByRole("button", { name: "Delete chart.png" }).click();
  const confirm = log.getByRole("group", { name: "Delete chart.png" });
  await expect(confirm).toContainText(
    'Delete "chart.png" from AgentPier? The file in the agent\'s workspace stays.',
  );
  await confirm.getByRole("button", { name: "Keep" }).click();
  expect(deleted).toEqual([]);
  await log.getByRole("button", { name: "Delete chart.png" }).click();
  await log.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(log.getByText("This shared file is no longer available.")).toBeVisible();
  expect(deleted).toEqual([["DELETE", "dinner", "img"]]);
  await expect(log.getByRole("img", { name: "chart.png" })).toHaveCount(0);
});
