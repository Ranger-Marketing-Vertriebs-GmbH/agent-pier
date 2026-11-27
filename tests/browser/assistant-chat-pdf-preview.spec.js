import { readFileSync } from "node:fs";
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";
import { userAppFixture } from "../helpers/user-app-fixture.js";

// A PDF in the agent chat opens page by page in a side panel (a bottom sheet on
// phones): pdf.js reads the bytes from the attachment route without download=1 and
// draws each page on a canvas as it scrolls in. A file over 10 MB, or one pdf.js
// cannot open, says so and keeps the download. Nothing logs an error or a CSP
// violation on the way, also when the panel closes while the PDF still loads.
const chat = "/agents/home/chats/dinner";
const pdf = readFileSync(new URL("../fixtures/two-pages.pdf", import.meta.url));
const file = (id, name, size, type, kind) => ({ id, name, type, kind, size });
const files = [
  file("pdf", "report.pdf", pdf.length, "application/pdf", "document"),
  file("bigpdf", "scan.pdf", 11 * 1024 * 1024, "application/pdf", "document"),
  file("bad", "broken.pdf", 20, "application/pdf", "document"),
];
const shared = (attachments) => ({
  id: "shared-file:docs",
  role: "assistant",
  text: "Your documents",
  timestamp: 2,
  runId: null,
  shared: true,
  attachments,
});

// Page errors, console errors and CSP violations of the page and its workers.
const errors = new WeakMap();
test.beforeEach(async ({ page }) => {
  const seen = [];
  errors.set(page, seen);
  const listen = (source) =>
    source.on("console", (message) => {
      if (message.type() === "error") seen.push(message.text());
    });
  listen(page);
  page.on("worker", listen);
  page.on("pageerror", (error) => seen.push(String(error)));
  await page.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (event) =>
      console.error(`CSP: ${event.violatedDirective} ${event.blockedURI}`),
    ),
  );
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
});

function track(page) {
  const seen = { attachments: [], fonts: [] };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (/attachments\/[^/]+$/.test(url.pathname))
      seen.attachments.push(`${url.pathname.split("/").at(-1)}${url.search}`);
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/assets/pdfjs/standard_fonts/"))
      seen.fonts.push(`${url.pathname.split("/").at(-1)} ${response.status()}`);
  });
  return seen;
}

async function serve(page, pattern, { delay = 0 } = {}) {
  await page.route(pattern, async (route) => {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    await route
      .fulfill({
        status: 200,
        contentType: "application/octet-stream",
        headers: { "x-content-type-options": "nosniff" },
        body: id === "pdf" ? pdf : "not a pdf at all",
      })
      // The page may be gone by the time a delayed answer is due.
      .catch(() => {});
  });
}

async function open(page, options = {}) {
  await chatFixture(page, {
    language: "en",
    history: { messages: [shared(files)], requests: [], stale: false },
  });
  await serve(page, /\/api\/assistant-attachments\//, options);
  const seen = track(page);
  await page.goto(baseURL + chat);
  return { log: page.getByRole("log"), seen };
}

const width = (locator) => locator.evaluate((node) => node.getBoundingClientRect().width);
// A drawn page has a backing store and dark text pixels on it.
const drawn = (canvas) =>
  canvas.evaluate((node) => {
    if (!node.width || !node.height) return false;
    const { data } = node.getContext("2d").getImageData(0, 0, node.width, node.height);
    for (let i = 0; i < data.length; i += 4)
      if (data[i + 3] > 128 && data[i] < 128) return true;
    return false;
  });

// The desktop run keeps the project's viewport (a tablet in the WebKit run).
for (const [view, use] of [
  ["desktop", {}],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
])
  test.describe(view, () => {
    test.use(use);

    test("a shared PDF opens in a side panel with all its pages", async ({ page }) => {
      const { log, seen } = await open(page);
      const opener = log.getByRole("button", { name: "Preview report.pdf" });
      await opener.click();
      const panel = page.getByRole("dialog", { name: "report.pdf" });
      await expect(panel.getByText("2 pages")).toBeVisible();
      const first = panel.getByRole("img", { name: "Page 1 of 2" });
      const second = panel.getByRole("img", { name: "Page 2 of 2" });
      await expect(first).toBeVisible();
      await expect.poll(() => drawn(first)).toBe(true);
      // Within one panel height of the visible area, page 2 is drawn before it shows.
      await expect.poll(() => drawn(second)).toBe(true);
      await second.scrollIntoViewIfNeeded();
      expect(await width(second)).toBeGreaterThan(0);
      // Neither font is embedded. Helvetica comes from the system; ZapfDingbats has
      // no system font, so pdf.js reads its stand-in from the app's own assets.
      expect(seen.fonts).toEqual(["FoxitDingbats.pfb 200"]);
      expect(seen.attachments).toEqual(["pdf"]);
      const download = panel.getByRole("link", { name: "Download report.pdf" });
      await expect(download).toHaveText("Download");
      await expect(download).toHaveAttribute("href", /\/pdf\?download=1$/);
      // The panel stays inside the screen; zoomed pages scroll inside it.
      const box = await panel.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);

      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(opener).toBeFocused();
    });

    test("zoom changes the page width", async ({ page }) => {
      const { log } = await open(page);
      await log.getByRole("button", { name: "Preview report.pdf" }).click();
      const panel = page.getByRole("dialog", { name: "report.pdf" });
      const first = panel.getByRole("img", { name: "Page 1 of 2" });
      const second = panel.getByRole("img", { name: "Page 2 of 2" });
      const zoomIn = panel.getByRole("button", { name: "Zoom in" });
      const fitWidth = panel.getByRole("button", { name: "Fit width" });
      await expect(first).toBeVisible();
      const fit = await width(first);
      await zoomIn.click();
      await expect.poll(() => width(first)).toBeGreaterThan(fit);
      // Zoomed pages scroll inside the panel, never the page.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
        page.viewportSize().width,
      );
      // Zoomed until page 2 is below the panel's visible area: within one panel height
      // of it, it is drawn before it scrolls in.
      const below = () =>
        second.evaluate(
          (node) =>
            node.getBoundingClientRect().top >
            node.closest(".side-panel-body").getBoundingClientRect().bottom,
        );
      for (let step = 0; step < 5 && !(await below()); step += 1) {
        const before = await width(first);
        await zoomIn.click();
        await expect.poll(() => width(first)).toBeGreaterThan(before);
      }
      expect(await below()).toBe(true);
      await expect.poll(() => drawn(second)).toBe(true);
      await fitWidth.click();
      await expect.poll(() => width(first)).toBe(fit);
      // Fit width is now unavailable, yet focus stays in the panel.
      await expect(fitWidth).toHaveAttribute("aria-disabled", "true");
      expect(await panel.evaluate((node) => node.contains(document.activeElement))).toBe(
        true,
      );
      await panel.getByRole("button", { name: "Zoom out" }).click();
      await expect.poll(() => width(first)).toBeLessThan(fit);
      await fitWidth.click();
      await expect.poll(() => width(first)).toBe(fit);
      await expect.poll(() => drawn(first)).toBe(true);
    });

    test("a PDF over 10 MB says so and keeps the download", async ({ page }) => {
      const { log, seen } = await open(page);
      await log.getByRole("button", { name: "Preview scan.pdf" }).click();
      const panel = page.getByRole("dialog", { name: "scan.pdf" });
      await expect(panel.getByRole("status")).toHaveText(
        "This file is larger than 10 MB, too large for a preview. Download it to read it.",
      );
      await expect(panel.getByRole("link", { name: "Download scan.pdf" })).toBeVisible();
      expect(seen.attachments).toEqual([]);
    });

    test("a broken PDF shows the failure and keeps the download", async ({ page }) => {
      const { log } = await open(page);
      await log.getByRole("button", { name: "Preview broken.pdf" }).click();
      const panel = page.getByRole("dialog", { name: "broken.pdf" });
      await expect(panel.getByRole("alert")).toHaveText(
        "The preview could not be loaded. You can still download the file.",
      );
      await expect(
        panel.getByRole("link", { name: "Download broken.pdf" }),
      ).toBeVisible();
    });

    test("closing while loading leaves no errors", async ({ page }) => {
      const { log, seen } = await open(page, { delay: 500 });
      // The pdf.js worker lives only while a document is open: destroy() ends it.
      const others = page.workers().length;
      await log.getByRole("button", { name: "Preview report.pdf" }).click();
      const panel = page.getByRole("dialog", { name: "report.pdf" });
      await expect(panel.getByRole("status")).toHaveText("Loading preview …");
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      // The answer arrives after the panel closed; nothing is drawn, opened or logged.
      await page.waitForTimeout(800);
      expect(seen.attachments).toEqual(["pdf"]);
      await expect.poll(() => page.workers().length).toBe(others);
      // Closed again once the document is open, while its pages are being drawn.
      const opener = log.getByRole("button", { name: "Preview report.pdf" });
      await opener.click();
      await expect(panel.getByText("2 pages")).toBeVisible();
      expect(page.workers().length).toBe(others + 1);
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(opener).toBeFocused();
      await expect.poll(() => page.workers().length).toBe(others);
    });
  });

test("a user previews a PDF in her own app through her route", async ({ page }) => {
  const state = await userAppFixture(page, {
    language: "en",
    messages: { main: [shared([files[0]])] },
  });
  await serve(page, /\/api\/me\/attachments\//);
  const seen = track(page);
  await page.goto(baseURL + "/agents/lotta/chats/main");
  await page.getByRole("button", { name: "Preview report.pdf" }).click();
  const panel = page.getByRole("dialog", { name: "report.pdf" });
  await expect(panel.getByText("2 pages")).toBeVisible();
  await expect
    .poll(() => drawn(panel.getByRole("img", { name: "Page 1 of 2" })))
    .toBe(true);
  expect(seen.attachments).toEqual(["pdf"]);
  expect(state.foreign).toEqual([]);
});
