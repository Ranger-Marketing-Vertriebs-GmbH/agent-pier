import { test, expect } from "../helpers/browser-test.js";
import { explorerFixture, selectEnglish } from "../helpers/file-explorer-browser.js";
import { baseURL } from "../helpers/browser.js";

const path = "/home/test/sample.js";
const editorURL = `${baseURL}/files?path=%2Fhome%2Ftest&file=${encodeURIComponent(path)}`;
const source =
  'const answer = 42;\nfunction greet(name) {\n  return "hi " + name; // note\n}\n';

async function setup(page) {
  await explorerFixture(page);
  await page.route("**/api/files/text**", (route) =>
    route.fulfill({
      json: {
        path,
        resolvedPath: path,
        text: source,
        bom: false,
        lineEnding: "lf",
        readOnly: false,
        revision: `d1:${"1".repeat(64)}`,
        metadataRevision: `e1:${"1".repeat(64)}`,
      },
    }),
  );
}

// WCAG relative luminance contrast of every coloured token against the editor.
async function syntaxContrasts(page) {
  return page.locator(".cm-content").evaluate((content) => {
    const rgb = (value) =>
      value
        .match(/\d+(\.\d+)?/g)
        .slice(0, 3)
        .map(Number);
    const lum = (value) => {
      const [r, g, b] = rgb(value).map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    let node = content;
    let background = "rgba(0, 0, 0, 0)";
    while (node && /rgba\(0, 0, 0, 0\)|transparent/.test(background)) {
      background = getComputedStyle(node).backgroundColor;
      node = node.parentElement;
    }
    return [...content.querySelectorAll(".cm-line span")].map((span) => {
      const color = getComputedStyle(span).color;
      const [hi, lo] = [lum(color), lum(background)].sort((a, b) => b - a);
      return { text: span.textContent, color, ratio: (hi + 0.05) / (lo + 0.05) };
    });
  });
}

for (const [label, viewport] of [
  ["desktop", { width: 1440, height: 1000 }],
  ["phone", { width: 390, height: 844 }],
]) {
  test(`the file editor colours code readably on the dark theme (${label})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await setup(page);
    await selectEnglish(page);
    await page.goto(editorURL);
    await page.getByRole("button", { name: "Open in editor", exact: true }).click();
    const content = page.getByRole("textbox", { name: `Document content: ${path}` });
    await expect(content).toContainText("answer");
    await expect
      .poll(async () => (await syntaxContrasts(page)).length)
      .toBeGreaterThan(4);
    const spans = await syntaxContrasts(page);
    const keyword = spans.find((span) => span.text === "const");
    expect(keyword, "the keyword is highlighted").toBeTruthy();
    // CodeMirror's light default style paints keywords rgb(119, 0, 136).
    expect(keyword.color).not.toBe("rgb(119, 0, 136)");
    for (const span of spans)
      expect(span.ratio, `${span.text} ${span.color}`).toBeGreaterThanOrEqual(4.5);
    const colours = new Set(spans.map((span) => span.color));
    expect(colours.size, "keywords, strings and numbers differ").toBeGreaterThan(3);
  });
}
