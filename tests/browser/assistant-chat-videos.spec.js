import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";
import { mp4File } from "../helpers/video-fixtures.js";

const words = {
  en: {
    options: "Options",
    attach: "Attach file, image or video",
    list: "Attachments",
    sent: "Attached files",
    send: "Send",
    progress: /^Uploading … \d+ %$/,
    video: (name) => `Video ${name}`,
    tooLarge: '"long.mov" is larger than 200 MB.',
  },
  de: {
    options: "Optionen",
    attach: "Datei, Bild oder Video anhängen",
    list: "Anhänge",
    sent: "Angehängte Dateien",
    send: "Senden",
    progress: /^Wird hochgeladen … \d+ %$/,
    video: (name) => `Video ${name}`,
    tooLarge: "„long.mov“ ist größer als 200 MB.",
  },
};
const viewports = [
  { name: "desktop", width: 1280, height: 860 },
  { name: "phone", width: 390, height: 844 },
];
const MiB = 1024 * 1024;

// A short clip the browser itself records from a canvas: WebM in Chromium, MP4 in
// WebKit, so each engine gets a video it can decode. Null without MediaRecorder.
function recordClip(page) {
  return page.evaluate(async () => {
    if (typeof MediaRecorder !== "function") return null;
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 120;
    const context = canvas.getContext("2d");
    const stream = canvas.captureStream(15);
    const type = ["video/webm", "video/mp4"].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    if (!type) return null;
    const recorder = new MediaRecorder(stream, { mimeType: type });
    const parts = [];
    recorder.ondataavailable = (event) => event.data.size && parts.push(event.data);
    const stopped = new Promise((resolve) => (recorder.onstop = resolve));
    recorder.start(100);
    for (let frame = 0; frame < 24; frame++) {
      context.fillStyle = `hsl(${frame * 15}, 70%, 50%)`;
      context.fillRect(0, 0, 160, 120);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    recorder.stop();
    await stopped;
    const blob = new Blob(parts, { type });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { type: type.split(";")[0], base64: btoa(binary) };
  });
}

// Answers the video routes like the server: chunks by offset, then the record.
async function videoRoutes(page, state) {
  state.chunks = [];
  await page.route(
    /\/api\/assistant-conversations\/[^/]+\/video-uploads/,
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const body = request.postDataBuffer() || Buffer.alloc(0);
      if (request.method() === "DELETE") return route.fulfill({ status: 204, body: "" });
      if (request.method() === "POST") {
        state.size = Number(url.searchParams.get("size"));
        state.name = url.searchParams.get("name");
        state.received = 0;
      } else if (Number(url.searchParams.get("offset")) !== state.received)
        return route.fulfill({ status: 409, json: { received: state.received } });
      // Playwright's WebKit hands routes no Blob bodies; the browser still sends them.
      const length = body.length || Math.min(8 * MiB, state.size - state.received);
      state.chunks.push({ method: request.method(), length: body.length });
      state.received += length;
      // A slow line: the composer shows how far the video is.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (state.received < state.size)
        return route.fulfill({
          status: request.method() === "POST" ? 201 : 200,
          json: { upload: "u1", received: state.received },
        });
      return route.fulfill({
        status: 201,
        json: {
          id: "video-1",
          name: state.name,
          type: "video/quicktime",
          kind: "video",
          size: state.size,
          video: { duration: 42, width: 1080, height: 1920 },
        },
      });
    },
  );
}

// Serves the recorded clip with byte ranges, as Safari insists on.
async function clipRoute(page, clip, state) {
  const bytes = Buffer.from(clip.base64, "base64");
  state.ranges = [];
  await page.route(/\/api\/assistant-attachments\/clip-1$/, (route) => {
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || "");
    if (!range)
      return route.fulfill({
        status: 200,
        headers: { "content-type": clip.type, "accept-ranges": "bytes" },
        body: bytes,
      });
    const start = Number(range[1]);
    const end = range[2]
      ? Math.min(Number(range[2]), bytes.length - 1)
      : bytes.length - 1;
    state.ranges.push(`${start}-${end}`);
    return route.fulfill({
      status: 206,
      headers: {
        "content-type": clip.type,
        "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${bytes.length}`,
      },
      body: bytes.subarray(start, end + 1),
    });
  });
}

async function pick(page, w, files) {
  await page.getByRole("button", { name: w.options, exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: w.attach }).click();
  await (await chooser).setFiles(files);
}

for (const language of ["en", "de"])
  for (const viewport of viewports)
    test(`${language} ${viewport.name}: a phone video uploads in chunks with progress`, async ({
      page,
      browserName,
    }) => {
      const w = words[language];
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-videos-spec-"));
      try {
        // Nine MiB: two chunks.
        const movie = path.join(directory, "IMG_0042.MOV");
        fs.writeFileSync(
          movie,
          mp4File({ brand: "qt  ", compatible: ["qt  "], payload: 9 * MiB }),
        );
        const long = path.join(directory, "long.mov");
        fs.writeFileSync(long, "");
        fs.truncateSync(long, 200 * MiB + 1);
        await page.setViewportSize(viewport);
        const state = await chatFixture(page, { language });
        await videoRoutes(page, state);
        await page.route(/\/attachment-policy$/, (route) =>
          route.fulfill({ json: { imageInput: true, maxBytes: 10 * MiB, maxFiles: 5 } }),
        );
        await page.goto(baseURL + "/agents/home/chats/dinner");
        // The phone picker offers videos next to photos.
        await expect(page.locator('input[type="file"]')).toHaveAttribute(
          "accept",
          /(?:^|,)video\/\*(?:,|$)/,
        );
        await pick(page, w, [long]);
        await expect(page.getByRole("alert")).toHaveText(w.tooLarge);
        await pick(page, w, [movie]);
        const tray = page.getByRole("list", { name: w.list });
        await expect(tray.getByText(w.progress)).toBeVisible();
        await expect(page.getByRole("button", { name: w.send })).toBeDisabled();
        await expect(page.getByRole("button", { name: w.send })).toBeEnabled({
          timeout: 15000,
        });
        expect(state.chunks.map((c) => c.method)).toEqual(["POST", "PUT"]);
        if (browserName === "chromium") expect(state.chunks[0].length).toBe(8 * MiB);
        await page.locator("#assistant-message").fill("What happens here?");
        await page.getByRole("button", { name: w.send }).click();
        await expect.poll(() => state.posted.length).toBe(1);
        expect(state.posted[0].attachments).toEqual(["video-1"]);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });

for (const viewport of viewports)
  test(`en ${viewport.name}: a sent video plays inline from byte ranges`, async ({
    page,
    browserName,
  }) => {
    const w = words.en;
    await page.setViewportSize(viewport);
    await page.goto(baseURL + "/");
    const clip = await recordClip(page);
    test.skip(!clip, `${browserName} records no video here`);
    const state = await chatFixture(page, { language: "en" });
    state.history = {
      ...state.history,
      messages: [
        ...state.history.messages,
        {
          id: "with-video",
          role: "user",
          text: "Look at this",
          attachments: [
            {
              id: "clip-1",
              name: "clip.mov",
              type: clip.type,
              kind: "video",
              size: Buffer.from(clip.base64, "base64").length,
              video: { duration: 1.4, width: 160, height: 120 },
            },
          ],
        },
      ],
    };
    await clipRoute(page, clip, state);
    await page.goto(baseURL + "/agents/home/chats/dinner");
    const sent = page.getByRole("list", { name: w.sent });
    const video = sent.locator("video");
    await expect(video).toHaveAttribute("aria-label", w.video("clip.mov"));
    await expect(video).toHaveAttribute("preload", "metadata");
    await expect(video).toHaveJSProperty("playsInline", true);
    await expect(sent.getByText("clip.mov")).toBeVisible();
    await expect.poll(() => video.evaluate((v) => v.readyState)).toBeGreaterThan(0);
    await video.evaluate((v) => {
      v.muted = true;
      return v.play();
    });
    await expect.poll(() => video.evaluate((v) => v.currentTime)).toBeGreaterThan(0);
  });
