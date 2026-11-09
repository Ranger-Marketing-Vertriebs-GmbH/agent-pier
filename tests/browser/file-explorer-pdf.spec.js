import { test, expect } from "../helpers/browser-test.js";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { chooseLanguage } from "../helpers/settings.js";

// A real one-page PDF with a binary comment line, as every PDF writer emits.
const pdf = Buffer.concat([
  Buffer.from("%PDF-1.4\n%"),
  Buffer.from([0xe2, 0xe3, 0xcf, 0xd3]),
  Buffer.from(
    "\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
      "trailer<</Root 1 0 R/Size 4>>\n%%EOF\n",
  ),
]);

for (const [label, viewport] of [
  ["desktop", { width: 1280, height: 800 }],
  ["phone", { width: 390, height: 844 }],
]) {
  test(`${label}: a PDF opens from the real route with sandboxed inline headers`, async ({
    browser,
  }) => {
    test.setTimeout(90000);
    const cleanups = [];
    try {
      const f = await applicationFixture({ after: (cleanup) => cleanups.push(cleanup) });
      const file = path.join(f.home, "doc.pdf");
      await fs.writeFile(file, pdf);
      const context = await browser.newContext({ acceptDownloads: true, viewport });
      cleanups.push(() => context.close());
      await context.addCookies([
        {
          name: "agentpier_session",
          value: f.cookie.slice(f.cookie.indexOf("=") + 1),
          url: f.url,
          httpOnly: true,
          sameSite: "Strict",
        },
      ]);
      const page = await context.newPage();
      const consoleErrors = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      await page.goto(`${f.url}/settings`);
      await chooseLanguage(page, "en");
      await page.goto(`${f.url}/files?path=${encodeURIComponent(f.home)}`);
      await page.getByRole("button", { name: "doc.pdf", exact: true }).click();

      const open = page.getByRole("link", { name: "Open PDF", exact: true });
      await expect(open).toBeVisible();
      await expect(page.getByText("This file type cannot be previewed.")).toHaveCount(0);
      const encoded = new URLSearchParams({ path: file }).toString().slice(5);
      await expect(open).toHaveAttribute(
        "href",
        `/api/files/download?path=${encoded}&inline=1`,
      );

      const inline = await context.request.get(f.url + (await open.getAttribute("href")));
      expect(inline.status()).toBe(200);
      const headers = inline.headers();
      expect(headers["content-type"]).toBe("application/pdf");
      expect(headers["content-disposition"]).toMatch(/^inline;/);
      expect(headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
      expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(await inline.body()).toEqual(pdf);

      const plain = await context.request.get(
        f.url + `/api/files/download?path=${encoded}`,
      );
      expect(plain.headers()["content-type"]).toBe("application/octet-stream");
      expect(plain.headers()["content-disposition"]).toMatch(/^attachment;/);

      // The link itself: a new window that gets the PDF response (headless
      // browsers hand the viewer's PDF to a download instead of rendering it).
      const responded = context.waitForEvent("response", {
        predicate: (response) => response.url().includes("inline=1"),
      });
      const [popup] = await Promise.all([context.waitForEvent("page"), open.click()]);
      const response = await responded;
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toBe("application/pdf");
      await popup.close();
      expect(
        consoleErrors.filter((text) => /Content Security Policy/i.test(text)),
      ).toEqual([]);
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  });
}
