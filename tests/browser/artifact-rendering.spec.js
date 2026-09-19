import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
const file = (path, mediaType, text) => ({
  path,
  mediaType,
  base64: Buffer.from(text).toString("base64"),
});
const bundle = (html, files = []) => ({
  artifact: { id: "example", title: "Report" },
  entrypoint: "index.html",
  files: [file("index.html", "text/html", html), ...files],
});
async function fixture(page, snapshot) {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route("**/api/artifacts/example/bundle", (route) =>
    route.fulfill({ json: snapshot }),
  );
  await page.goto(`${base}/artifacts/view/example`);
  return page.frameLocator('iframe[title="Artifact"]');
}
test("private artifact renders CSS, images, classic and cyclic module scripts", async ({
  page,
}) => {
  const frame = await fixture(
    page,
    bundle(
      '<link rel="stylesheet" href="styles/main.css"><img alt="shape" src="shape.svg"><button>Increment</button><output>0</output><script src="classic.js"></script><script type="module" src="main.js"></script>',
      [
        file(
          "styles/main.css",
          "text/css",
          '@import "nested.css"; body { color: rgb(12, 34, 56); }',
        ),
        file(
          "styles/nested.css",
          "text/css",
          "button { background-image: url(../shape.svg); }",
        ),
        file(
          "shape.svg",
          "image/svg+xml",
          '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>',
        ),
        file("classic.js", "text/javascript", 'document.body.dataset.classic="yes";'),
        file(
          "main.js",
          "text/javascript",
          'import { increment } from "./dep.js"; export const count = () => 1; document.querySelector("button").onclick = async () => { await import("./dep.js"); document.querySelector("output").textContent = increment(); };',
        ),
        file(
          "dep.js",
          "text/javascript",
          'import { count } from "./main.js"; export const increment = () => count();',
        ),
      ],
    ),
  );
  await expect(frame.locator("body")).toHaveAttribute("data-classic", "yes");
  await frame.getByRole("button", { name: "Increment" }).click();
  await expect(frame.locator("output")).toHaveText("1");
  await expect(frame.locator("body")).toHaveCSS("color", "rgb(12, 34, 56)");
  await expect(frame.getByRole("img", { name: "shape" })).toHaveJSProperty(
    "naturalWidth",
    20,
  );
});
test("artifact cannot access parent, cookies, storage, APIs or open another context", async ({
  page,
}) => {
  const apiRequests = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/accounts")) apiRequests.push(request.url());
  });
  const frame = await fixture(
    page,
    bundle(`<p id="parent"></p><p id="storage"></p><p id="cookie"></p><p id="api"></p><p id="popup"></p><script>
    for (const [id, fn] of [["parent", () => parent.document.body], ["storage", () => localStorage.length], ["cookie", () => { if (!document.cookie) throw Error("empty cookie jar"); return document.cookie; }]]) {
      try { fn(); document.getElementById(id).textContent="allowed"; } catch { document.getElementById(id).textContent="blocked"; }
    }
    fetch("${base}/api/accounts", {credentials:"include"}).then(() => document.querySelector("#api").textContent="allowed").catch(() => document.querySelector("#api").textContent="blocked");
    document.querySelector("#popup").textContent = window.open("${base}/accounts") ? "allowed" : "blocked";
    try { top.location.href="${base}/accounts"; } catch {}
  </script>`),
  );
  for (const id of ["parent", "storage", "cookie", "api", "popup"])
    await expect(frame.locator(`#${id}`)).toHaveText("blocked");
  await expect(page.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
  expect(apiRequests).toEqual([]);
  await expect(page).toHaveURL(`${base}/artifacts/view/example`);
});

test("inline classic scripts preserve parser order despite async and defer attributes", async ({
  page,
}) => {
  const frame = await fixture(
    page,
    bundle(`<body>
    <script defer>window.first = "first";</script>
    <script async>window.second = window.first + " second";</script>
    <script>document.body.dataset.order = window.second;</script>
  </body>`),
  );
  await expect(frame.locator("body")).toHaveAttribute("data-order", "first second");
});

test("inline SVG images load bundled href and xlink resources", async ({ page }) => {
  const frame = await fixture(
    page,
    bundle(
      `<svg xmlns:xlink="http://www.w3.org/1999/xlink">
    <image href="shape.svg" width="20" height="20" onload="this.setAttribute('data-loaded', 'yes')"/>
    <image xlink:href="shape.svg" x="20" width="20" height="20" onload="this.setAttribute('data-loaded', 'yes')"/>
  </svg>`,
      [
        file(
          "shape.svg",
          "image/svg+xml",
          '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>',
        ),
      ],
    ),
  );
  await expect(frame.locator("image").nth(0)).toHaveAttribute("data-loaded", "yes");
  await expect(frame.locator("image").nth(1)).toHaveAttribute("data-loaded", "yes");
});

test("bundled SVG view fragments select the intended image region", async ({ page }) => {
  const frame = await fixture(
    page,
    bundle('<img alt="view" src="picture.svg#red">', [
      file(
        "picture.svg",
        "image/svg+xml",
        `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">
      <view id="red" viewBox="0 0 10 20" preserveAspectRatio="none"/>
      <rect width="10" height="20" fill="red"/><rect x="10" width="10" height="20" fill="blue"/>
    </svg>`,
      ),
    ]),
  );
  const img = frame.getByRole("img", { name: "view" });
  await expect(img).toHaveJSProperty("naturalWidth", 20);
  const pixel = await img.evaluate((image) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 20;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, 20, 20);
    return [...context.getImageData(15, 10, 1, 1).data];
  });
  expect(pixel).toEqual([255, 0, 0, 255]);
});
