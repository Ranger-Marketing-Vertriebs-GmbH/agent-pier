import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
const file = (path, mediaType, text) => ({
  path,
  mediaType,
  base64: Buffer.from(text).toString("base64"),
});
const snapshot = {
  artifact: { id: "example", title: "Bundled report" },
  entrypoint: "warm.html",
  files: [
    file(
      "warm.html",
      "text/html",
      '<h1>Overview</h1><a href="pages/comparison.html">Bestandsvergleich</a>',
    ),
    file(
      "pages/comparison.html",
      "text/html",
      '<h1>Comparison</h1><img alt="shape" src="../shape.svg"><a href="../warm.html">Overview</a><a href="../shape.svg">Original image</a>',
    ),
    file(
      "shape.svg",
      "image/svg+xml",
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>',
    ),
  ],
};
async function fixture(page, data = snapshot) {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route("**/api/artifacts/example/bundle", (route) =>
    route.fulfill({ json: data }),
  );
  await page.goto(`${baseURL}/artifacts/view/example`);
  return page.frameLocator("iframe");
}

test("mobile artifact follows bundled page and image links without leaving the sandbox", async ({
  page,
}) => {
  const requests = [];
  page.on("request", (request) => {
    if (/\/artifacts\/view\/(pages|shape|warm)/.test(request.url()))
      requests.push(request.url());
  });
  const frame = await fixture(page);
  await frame.getByRole("link", { name: "Bestandsvergleich" }).tap();
  await expect(frame.getByRole("heading", { name: "Comparison" })).toBeVisible();
  await expect(frame.getByRole("img", { name: "shape" })).toHaveJSProperty(
    "naturalWidth",
    20,
  );
  if (process.env.CAPTURE_ARTIFACT_LINK_SCREENSHOT)
    await page.screenshot({ path: "docs/screenshots/artifact-links-mobile.png" });
  await frame.getByRole("link", { name: "Overview" }).tap();
  await expect(frame.getByRole("heading", { name: "Overview" })).toBeVisible();
  await frame.getByRole("link", { name: "Bestandsvergleich" }).tap();
  await frame.getByRole("link", { name: "Original image" }).tap();
  await expect(frame.locator("img")).toHaveJSProperty("naturalWidth", 20);
  await page.getByRole("button", { name: "Previous artifact page" }).tap();
  await expect(frame.getByRole("heading", { name: "Comparison" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to AgentPier" })).toBeVisible();
  await expect(page.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
  await expect(page).toHaveURL(`${baseURL}/artifacts/view/example`);
  expect(requests).toEqual([]);
});

test("mobile bundle navigation preserves fragments and reports unavailable links without losing the page", async ({
  page,
}) => {
  const frame = await fixture(page, {
    ...snapshot,
    files: [
      file(
        "warm.html",
        "text/html",
        '<h1>Overview</h1><a href="pages/details.html?view=all#result">Details</a>',
      ),
      file(
        "pages/details.html",
        "text/html",
        '<a href="#result">Jump</a><a href="missing.html">Missing</a><a href="https://example.com/">External</a><a href="/api/accounts">Private API</a><a href="../../warm.html">Outside bundle</a><div style="height:3000px"></div><h2 id="result">Result</h2>',
      ),
    ],
  });
  await frame.getByRole("link", { name: "Details" }).tap();
  await expect(frame.getByRole("heading", { name: "Result" })).toBeInViewport();
  for (const name of ["Missing", "External", "Private API", "Outside bundle"]) {
    await frame.getByRole("link", { name, exact: true }).tap();
    await expect(page.getByRole("alert")).toHaveText(/This link cannot be opened here/);
    await expect(frame.getByRole("heading", { name: "Result" })).toHaveCount(1);
  }
  await frame.getByRole("link", { name: "Jump" }).tap();
  await expect(frame.getByRole("heading", { name: "Result" })).toBeInViewport();
  await page.getByRole("button", { name: "Previous artifact page" }).tap();
  await expect(frame.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("viewer rejects link messages from other windows and stale documents", async ({
  page,
}) => {
  const frame = await fixture(page);
  await expect(frame.getByRole("heading", { name: "Overview" })).toBeVisible();
  const token = await frame.locator("body").evaluate(() => {
    const source = [...document.scripts]
      .map((script) => {
        try {
          return atob(script.src.split(",")[1]);
        } catch {
          return "";
        }
      })
      .find((text) => text.includes("agentpier:artifact-link"));
    return source.match(/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}/)[0];
  });
  await page.evaluate(
    (token) =>
      window.postMessage(
        { type: "agentpier:artifact-link", token, href: "pages/comparison.html" },
        "*",
      ),
    token,
  );
  // A following valid click must still originate from the overview; a wrong-source
  // message would remove this link and open the comparison page.
  await frame.getByRole("link", { name: "Bestandsvergleich" }).tap();
  await expect(frame.getByRole("heading", { name: "Comparison" })).toBeVisible();
  await frame.locator("body").evaluate((body, token) => {
    parent.postMessage(
      { type: "agentpier:artifact-link", token, href: "../warm.html" },
      "*",
    );
    parent.postMessage(
      { type: "agentpier:artifact-link", token: "wrong", href: "../warm.html" },
      "*",
    );
  }, token);
  await frame.getByRole("link", { name: "Original image" }).tap();
  await expect(frame.locator("img")).toHaveJSProperty("naturalWidth", 20);
});
