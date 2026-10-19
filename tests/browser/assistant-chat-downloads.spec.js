import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

// Every video, audio and file in the agent chat has a visible download button: a
// download in a browser tab, the share sheet in the home-screen app (iOS), where
// the native players offer no download.
const chat = "/agents/home/chats/dinner";
const file = (id, name, type, kind, size = 2048) => ({ id, name, type, kind, size });
const messages = [
  {
    id: "question",
    role: "user",
    text: "My recording and notes.",
    timestamp: 1,
    attachments: [
      file("own-vid", "holiday.mov", "video/quicktime", "video"),
      file("own-txt", "notes.txt", "text/plain", "document"),
    ],
  },
  {
    id: "shared-file:media",
    role: "assistant",
    text: "Your clip, the narration and the script",
    timestamp: 2,
    runId: null,
    shared: true,
    attachments: [
      file("vid", "clip.mp4", "video/mp4", "video"),
      file("aud", "voice.mp3", "audio/mpeg", "audio"),
      file("pdf", "script.pdf", "application/pdf", "document"),
    ],
  },
];
const names = ["holiday.mov", "notes.txt", "clip.mp4", "voice.mp3", "script.pdf"];
const byId = Object.fromEntries(
  messages.flatMap((m) => m.attachments).map((f) => [f.id, f.name]),
);

const standalone = () => {
  const native = window.matchMedia.bind(window);
  window.matchMedia = (query) =>
    query.includes("display-mode: standalone")
      ? { matches: true, media: query, addEventListener() {}, removeEventListener() {} }
      : native(query);
  Object.defineProperty(navigator, "standalone", { value: true });
  window.sharedFiles = [];
  window.open = () => {};
  navigator.canShare = (data) => Array.isArray(data?.files);
  navigator.share = async ({ files }) => {
    window.sharedFiles.push(...files.map((f) => ({ name: f.name, size: f.size })));
  };
};

async function open(page, { language, installed = false }) {
  if (installed) await page.addInitScript(standalone);
  await chatFixture(page, {
    language,
    history: { messages, requests: [], stale: false },
  });
  const requests = [];
  await page.route(/\/api\/assistant-attachments\//, (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split("/").at(-1);
    requests.push(`${route.request().method()} ${id}${url.search}`);
    const save = url.searchParams.get("download") === "1";
    return route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      headers: {
        "content-disposition": save
          ? `attachment; filename*=UTF-8''${encodeURIComponent(byId[id])}`
          : "inline",
      },
      body: Buffer.alloc(2048, 1),
    });
  });
  page.attachmentRequests = requests;
  await page.goto(baseURL + chat);
  return page.getByRole("log");
}

const label = { en: (name) => `Download ${name}`, de: (name) => `${name} herunterladen` };

for (const language of ["en", "de"])
  for (const [view, use] of [
    ["desktop", {}],
    ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
  ])
    test.describe(`${language} ${view}`, () => {
      test.use(use);

      test("videos, audio and files show a download button", async ({ page }) => {
        const log = await open(page, { language });
        for (const name of names) {
          const button = log.getByRole("link", { name: label[language](name) });
          await expect(button).toBeVisible();
          await expect(button).toHaveAttribute("download", name);
          await expect(button).toHaveAttribute("href", /\?download=1$/);
          const box = await button.boundingBox();
          const floor = view === "phone" ? 44 : 33;
          expect(Math.round(box.width)).toBeGreaterThanOrEqual(floor);
          expect(Math.round(box.height)).toBeGreaterThanOrEqual(floor);
        }
        // Under the players, beside the name.
        const row = log.locator(".agent-message-video .agent-attachment-row").last();
        await expect(row).toContainText("clip.mp4");
        await expect(
          row.getByRole("link", { name: label[language]("clip.mp4") }),
        ).toBeVisible();
      });

      test("in a browser tab the button downloads the whole file by its name", async ({
        page,
      }) => {
        const log = await open(page, { language });
        for (const name of ["clip.mp4", "voice.mp3", "notes.txt"]) {
          const download = page.waitForEvent("download");
          await log.getByRole("link", { name: label[language](name) }).click();
          const saved = await download;
          expect(saved.suggestedFilename()).toBe(name);
          // The whole file as an attachment, not the range the player streams.
          expect(saved.url()).toMatch(
            /\/api\/assistant-attachments\/[\w-]+\?download=1$/,
          );
          await expect(page).toHaveURL(new RegExp(`${chat}$`));
        }
      });

      test("in the home-screen app the button shares the file and the chat stays", async ({
        page,
      }) => {
        const log = await open(page, { language, installed: true });
        for (const name of ["clip.mp4", "voice.mp3", "holiday.mov", "script.pdf"]) {
          await log.getByRole("link", { name: label[language](name) }).click();
          await expect
            .poll(() => page.evaluate(() => window.sharedFiles.map((f) => f.name)))
            .toContain(name);
          await expect(page).toHaveURL(new RegExp(`${chat}$`));
        }
        expect(await page.evaluate(() => window.sharedFiles[0].size)).toBe(2048);
        expect(page.attachmentRequests).toEqual(
          expect.arrayContaining(["HEAD vid?download=1", "GET vid?download=1"]),
        );
      });
    });
