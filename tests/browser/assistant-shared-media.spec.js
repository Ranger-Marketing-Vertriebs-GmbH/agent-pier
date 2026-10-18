import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

const chat = "/agents/home/chats/dinner";
const file = (id, name, type, kind, size = 2048) => ({ id, name, type, kind, size });
const messages = [
  { id: "question", role: "user", text: "Make me a clip.", timestamp: 1 },
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
      file("zip", "assets.zip", "application/octet-stream", "file"),
    ],
  },
];

// The installed home-screen app: display-mode standalone, and a share sheet that
// records what it was handed.
const standalone = () => {
  const native = window.matchMedia.bind(window);
  window.matchMedia = (query) =>
    query.includes("display-mode: standalone")
      ? { matches: true, media: query, addEventListener() {}, removeEventListener() {} }
      : native(query);
  Object.defineProperty(navigator, "standalone", { value: true });
  window.sharedFiles = [];
  navigator.canShare = (data) => Array.isArray(data?.files);
  navigator.share = async ({ files }) => {
    window.sharedFiles.push(...files.map((f) => ({ name: f.name, size: f.size })));
  };
};

async function open(page, { installed = false } = {}) {
  if (installed) await page.addInitScript(standalone);
  await chatFixture(page, { history: { messages, requests: [], stale: false } });
  await page.route(/\/api\/assistant-attachments\//, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      headers: { "content-disposition": "attachment" },
      body: Buffer.alloc(2048, 1),
    }),
  );
  await page.goto(baseURL + chat);
  return page.getByRole("log");
}

for (const [label, use] of [
  ["desktop", {}],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
]) {
  test.describe(label, () => {
    test.use(use);

    test("a shared video and audio play inline in the chat", async ({ page }) => {
      const log = await open(page, { installed: true });
      const video = log.getByLabel("Video clip.mp4");
      await expect(video).toBeVisible();
      await expect(video).toHaveAttribute(
        "src",
        "/api/assistant-attachments/vid#t=0.001",
      );
      expect(await video.evaluate((v) => [v.controls, v.playsInline, v.preload])).toEqual(
        [true, true, "metadata"],
      );
      const audio = log.getByLabel("Audio: voice.mp3");
      await expect(audio).toHaveAttribute("src", "/api/assistant-attachments/aud");
      expect(await audio.evaluate((a) => a.controls)).toBe(true);
      await video.click();
      await expect(page).toHaveURL(new RegExp(`${chat}$`));
    });

    test("in the home-screen app files go to the share sheet and the chat stays", async ({
      page,
    }) => {
      const log = await open(page, { installed: true });
      for (const name of ["script.pdf", "assets.zip", "clip.mp4"]) {
        await log.getByRole("link", { name: `Download ${name}` }).click();
        await expect
          .poll(() => page.evaluate(() => window.sharedFiles.map((f) => f.name)))
          .toContain(name);
        await expect(page).toHaveURL(new RegExp(`${chat}$`));
      }
      expect(await page.evaluate(() => window.sharedFiles[0].size)).toBe(2048);
      await expect(
        log.getByText("Your clip, the narration and the script"),
      ).toBeVisible();
    });

    test("in a browser tab files keep their plain download link", async ({ page }) => {
      const log = await open(page);
      const pdf = log.getByRole("link", { name: "Download script.pdf" });
      await expect(pdf).toHaveAttribute("download", "script.pdf");
      await expect(pdf).toHaveAttribute("href", "/api/assistant-attachments/pdf");
      expect(await log.locator(".agent-message-attachments a[target]").count()).toBe(0);
    });
  });
}
