import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";
import { png } from "../helpers/craft-pictures.js";
import { PAGE_CSP } from "../../server/features/assistants/agent-pinboard-pages.js";

// A pinned HTML page in the pinboard reader: shown in a frame sandboxed without
// scripts, its files served below a grant with the page policy, as the server does
// (agent-pinboard-pages.js, routes/assistant-pinboard.js).
const grant = "g".repeat(43);
const pictures = [
  ["01.png", [244, 154, 88], [255, 214, 170]],
  ["02.png", [90, 140, 220], [180, 210, 250]],
  ["03.png", [70, 160, 110], [170, 225, 190]],
  ["04.png", [200, 90, 140], [240, 190, 215]],
];
const gallery = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Galerie</title>
<link rel="stylesheet" href="style/site.css"></head>
<body>
<h1>Galerie Abnahme v1</h1>
<p><a href="szenen.html">Szenen</a> · <a href="https://example.test/out">Extern</a></p>
<div class="grid">
${pictures
  .map(
    ([name], i) =>
      `<figure><a href="bilder/${name}"><img src="bilder/${name}" alt="Bild ${i + 1}"></a><figcaption>Bild ${i + 1}</figcaption></figure>`,
  )
  .join("\n")}
</div>
<img src="missing.png" onerror="new Image().src='/script-ran/onerror'" alt="">
<script>document.title = "pwned"; document.body.dataset.ran = "1";
new Image().src = "/script-ran/inline";</script>
<script src="app.js"></script>
</body></html>`;
const files = {
  "index.html": ["text/html; charset=utf-8", gallery],
  "szenen.html": [
    "text/html; charset=utf-8",
    "<!doctype html><title>Szenen</title><h1>Szenen</h1>",
  ],
  "style/site.css": [
    "text/css; charset=utf-8",
    `body { font-family: sans-serif; margin: 24px; }
.grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
figure { margin: 0; } img { width: 100%; display: block; border-radius: 8px; }`,
  ],
  ...Object.fromEntries(
    pictures.map(([name, top, rest]) => [
      `bilder/${name}`,
      ["image/png", png(320, 200, [top, rest, rest])],
    ]),
  ),
};

async function open(page) {
  const state = { seen: [], pages: [], escaped: [] };
  await chatFixture(page, { language: "en" });
  await page.route(/\/api\/assistants\/home\/pinboard$/, (route) =>
    route.fulfill({
      json: {
        lists: [
          {
            id: "galleries",
            title: "Galleries",
            description: "",
            origin: null,
            archived: false,
            updatedAt: "2026-11-13T10:00:00.000Z",
            entries: [
              {
                id: "gallery",
                name: "index.html",
                note: "",
                version: 1,
                kind: "page",
                type: "text/html",
                size: gallery.length,
                state: "ok",
                fresh: state.seen.length === 0,
              },
            ],
          },
        ],
        fresh: state.seen.length === 0 ? 1 : 0,
      },
    }),
  );
  await page.route(/\/pinboard\/entries\/gallery\/seen$/, (route) => {
    state.seen.push("gallery");
    return route.fulfill({ status: 204 });
  });
  await page.route(/\/pinboard\/entries\/gallery\/page$/, (route) => {
    state.pages.push(route.request().method());
    return route.fulfill({ json: { url: `/api/pinboard-pages/${grant}/index.html` } });
  });
  await page.route(/\/api\/pinboard-pages\//, (route) => {
    const relative = new URL(route.request().url()).pathname.split(`/${grant}/`)[1];
    const file = files[relative];
    const headers = {
      "content-security-policy": PAGE_CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    };
    if (!file) return route.fulfill({ status: 404, headers, json: {} });
    return route.fulfill({
      headers: { ...headers, "content-type": file[0] },
      body: file[1],
    });
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/script-ran") || url.hostname.endsWith("example.test"))
      state.escaped.push(request.url());
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await page.getByRole("button", { name: /^Pinboard/ }).click();
  await page.getByRole("button", { name: /index\.html/ }).click();
  return state;
}

const pageFrame = (page) =>
  page.frames().find((frame) => frame.url().includes("/api/pinboard-pages/"));

test("a pinned HTML page shows its images without running its scripts", async ({
  page,
}, testInfo) => {
  const state = await open(page);
  const reader = page.locator(".pinboard-reader");
  const iframe = reader.locator("iframe.pinboard-reader-page");
  await expect(iframe).toHaveAttribute("sandbox", "");
  await expect(iframe).toHaveAttribute("title", "Page index.html");
  const frame = page.frameLocator("iframe.pinboard-reader-page");
  await expect(frame.getByRole("heading", { name: "Galerie Abnahme v1" })).toBeVisible();
  const first = frame.getByRole("img", { name: "Bild 1" });
  await expect(first).toBeVisible();
  await expect.poll(() => first.evaluate((img) => img.naturalWidth)).toBe(320);
  // The style sheet from the page's folder applies.
  await expect
    .poll(() => first.evaluate((img) => getComputedStyle(img).borderRadius))
    .toBe("8px");
  // Loaded with the frame: the NEW mark goes.
  await expect.poll(() => state.seen).toEqual(["gallery"]);
  await page.screenshot({ path: testInfo.outputPath("pinboard-page.png") });

  // No script ran: neither inline, nor a handler, nor a file.
  const content = pageFrame(page);
  expect(await content.evaluate(() => document.title)).toBe("Galerie");
  expect(await content.evaluate(() => document.body.dataset.ran ?? null)).toBe(null);
  const back = reader.getByRole("button", { name: "Back to the page" });
  await expect(back).toBeDisabled();

  // An image link shows the image itself in the frame.
  await first.click();
  await expect.poll(() => pageFrame(page)?.url()).toMatch(/\/bilder\/01\.png$/);
  await expect(back).toBeEnabled();
  await back.click();
  await expect(frame.getByRole("heading", { name: "Galerie Abnahme v1" })).toBeVisible();
  await expect(back).toBeDisabled();
  // Each opening asks for a grant.
  expect(state.pages).toEqual(["GET", "GET"]);

  // A sibling page opens in the frame; an external link goes nowhere.
  await frame.getByRole("link", { name: "Szenen" }).click();
  await expect(frame.getByRole("heading", { name: "Szenen" })).toBeVisible();
  await back.click();
  await frame.getByRole("link", { name: "Extern" }).click();
  await expect(back).toBeEnabled();
  expect(page.url()).toBe(baseURL + "/agents/home/chats/dinner");
  expect(state.escaped).toEqual([]);
});
