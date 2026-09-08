import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

async function fixture(context) {
  const inputs = [];
  const session = {
    id: "files",
    tool: "claude",
    accountId: "local-claude",
    name: "Files",
    cwd: "/fixture",
    status: "running",
  };
  await context.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let result = {};
    if (path === "/api/state")
      result = {
        accounts: [{ id: "local-claude", tool: "claude", kind: "local", name: "Claude" }],
        tools: [{ id: "claude", installed: true, name: "Claude" }],
        sessions: [session],
        home: "/fixture",
      };
    else if (path.endsWith("/chat"))
      result = {
        availability: "ready",
        providerSessionId: "native",
        messages: [],
        tasks: [],
      };
    else if (path.endsWith("/attachments"))
      return route.fulfill({ status: 503, json: { error: "Fixture upload failed" } });
    else if (path.endsWith("/input")) {
      const body = route.request().postDataJSON();
      inputs.push(body);
      result = { deliveryId: body.deliveryId, status: "handed-off" };
    }
    await route.fulfill({ json: result });
  });
  return inputs;
}

test("a second tab cannot send past a failed upload it has not yet displayed", async ({
  page,
  context,
}) => {
  const inputs = await fixture(context);
  await page.goto(baseURL + "/sessions/files/chat");
  const second = await context.newPage();
  await second.goto(baseURL + "/sessions/files/chat");
  await second
    .getByRole("textbox", { name: "Nachricht", exact: true })
    .fill("Datei nicht verlieren");
  await expect(second.getByRole("button", { name: "Senden", exact: true })).toBeEnabled();
  await page.setInputFiles('input[type="file"]', {
    name: "keep.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("recover me"),
  });
  await expect(
    page.getByRole("button", { name: "Erneut hochladen: keep.txt" }),
  ).toBeVisible();
  await second.getByRole("button", { name: "Senden", exact: true }).click();
  await expect(
    second.getByText(
      "Es gibt noch offene Datei-Uploads. Bitte abschließen oder entfernen.",
    ),
  ).toBeVisible();
  expect(inputs).toHaveLength(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Erneut hochladen: keep.txt" }),
  ).toBeVisible();
  await expect(
    second.getByRole("textbox", { name: "Nachricht", exact: true }),
  ).toHaveValue("Datei nicht verlieren");
});

test("unreadable upload recovery storage blocks sending instead of losing unknown files", async ({
  page,
  context,
}) => {
  const inputs = await fixture(context);
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      value: {
        open() {
          throw new Error("Fixture denied");
        },
      },
    });
  });
  await page.goto(baseURL + "/sessions/files/chat");
  await page.getByRole("textbox", { name: "Nachricht", exact: true }).fill("Keep draft");
  await page.getByRole("button", { name: "Senden", exact: true }).click();
  await expect(
    page
      .locator(".error")
      .getByText("Datei konnte nicht für die Wiederherstellung gespeichert werden."),
  ).toBeVisible();
  expect(inputs).toHaveLength(0);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Nachricht", exact: true })).toHaveValue(
    "Keep draft",
  );
});
