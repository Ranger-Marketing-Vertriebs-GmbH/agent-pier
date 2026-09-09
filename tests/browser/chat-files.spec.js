import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

test("mobile chat uploads images and files, removes a selection, and sends attachments only on submit", async ({
  page,
  browserName,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const uploads = [],
    sent = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname.endsWith("/chat/attachments")) {
      const name = url.searchParams.get("name");
      uploads.push({ name, body: request.postDataBuffer() });
      return route.fulfill({
        status: 201,
        json: {
          name,
          path: `/private/uploads/${name}`,
          size: name === "photo.png" ? 4 : 16,
        },
      });
    }
    if (url.pathname.endsWith("/input")) {
      sent.push(request.postDataJSON());
      if (sent.length === 1)
        return route.fulfill({ status: 503, json: { error: "Senden fehlgeschlagen" } });
      return route.fulfill({
        json: { deliveryId: request.postDataJSON().deliveryId, status: "handed-off" },
      });
    }
    if (url.pathname.includes("/input/"))
      return route.fulfill({
        json: {
          deliveryId: url.pathname.split("/").at(-1),
          status: "absent",
          error: "Senden fehlgeschlagen",
        },
      });
    const json =
      url.pathname === "/api/state"
        ? {
            tools: [{ id: "claude", name: "Claude Code", installed: true }],
            accounts: [],
            home: "/fixture",
            sessions: [
              {
                id: "uploads",
                name: "Upload session",
                tool: "claude",
                cwd: "/fixture",
                status: "running",
              },
            ],
          }
        : url.pathname.endsWith("/chat")
          ? { availability: "ready", messages: [], tasks: [] }
          : {};
    return route.fulfill({ json });
  });
  await page.goto(baseURL + "/sessions/uploads/chat");
  await expect(
    page.getByRole("button", { name: "Datei hinzufügen", exact: true }),
  ).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles([
    { name: "photo.png", mimeType: "image/png", buffer: Buffer.from([137, 80, 78, 71]) },
    {
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Read these notes"),
    },
  ]);
  await expect(
    page.getByRole("button", { name: "Anhang entfernen: notes.txt" }),
  ).toBeVisible();
  // Selections appear optimistically before the upload requests complete.
  await expect
    .poll(() => uploads.map((upload) => upload.name).sort())
    .toEqual(["notes.txt", "photo.png"]);
  // WebKit interception exposes null for File bodies; the HTTP integration test
  // checks binary storage independently of browser interception support.
  if (browserName !== "webkit") {
    expect(uploads.find((upload) => upload.name === "photo.png").body).toEqual(
      Buffer.from([137, 80, 78, 71]),
    );
    expect(uploads.find((upload) => upload.name === "notes.txt").body.toString()).toBe(
      "Read these notes",
    );
  }
  expect(sent).toEqual([]);
  await page.getByRole("button", { name: "Anhang entfernen: notes.txt" }).click();
  await page.getByRole("button", { name: "Senden", exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  await expect(page.getByText("Senden fehlgeschlagen", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Anhang entfernen: photo.png" }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/agentpier-mobile-attachments.png" });
  await page
    .getByRole("button", { name: "Übergabe erneut versuchen", exact: true })
    .click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[0].text).toContain("/private/uploads/photo.png");
  expect(sent[0].text).not.toContain("notes.txt");
  expect(sent[0].submit).toBe(true);
  await expect(
    page.getByRole("button", { name: "Anhang entfernen: photo.png" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});
