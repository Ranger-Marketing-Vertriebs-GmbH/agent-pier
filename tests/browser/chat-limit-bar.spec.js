import { test, expect } from "../helpers/browser-test.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { baseURL } from "../helpers/browser.js";

const detail = "You've hit your Fable limit · resets Nov 20 at 4pm (Europe/Berlin)";

async function fixture(page, { limit = true, uploadGate = null } = {}) {
  const session = {
    id: "limited",
    accountId: "fixture",
    tool: "claude",
    cwd: "/fixture",
    status: "running",
    name: "Limited session",
    attachments: { directory: "/fixture/attachments" },
    activity: { state: "idle", ...(limit && { limit: { detail } }) },
  };
  const data = {
    availability: "ready",
    providerSessionId: "thread",
    messages: [{ id: "a1", role: "assistant", text: detail }],
    tasks: [],
  };
  await mockChatStream(page, () => data);
  const calls = { inputs: [], models: [] };
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/chat/attachments")) {
      await uploadGate;
      return route.fulfill({
        json: { name: "note.txt", path: "/fixture/attachments/note.txt" },
      });
    }
    const body =
      route.request().method() === "POST" ? route.request().postDataJSON() : null;
    let result = {};
    if (pathname === "/api/state")
      result = {
        sessions: [session],
        accounts: [],
        tools: [{ id: "claude", name: "Claude", installed: true }],
        home: "/fixture",
      };
    else if (pathname.endsWith("/chat")) result = data;
    else if (pathname.endsWith("/input")) {
      calls.inputs.push(body);
      result = { deliveryId: body.deliveryId, status: "handed-off" };
    } else if (pathname.includes("/input/"))
      result = { deliveryId: pathname.split("/").at(-1), status: "handed-off" };
    else if (pathname.includes("/models")) {
      if (body) calls.models.push(pathname.split("/").at(-1));
      result = {
        currentModel: "fable",
        currentSource: "cli",
        picker: pathname.endsWith("/open")
          ? {
              token: "model-token",
              title: "Select model",
              kind: "model",
              searchable: false,
              selected: "fable",
              options: [{ id: "fable", label: "Fable", current: true }],
            }
          : null,
        notice: null,
        pending: false,
      };
    }
    await route.fulfill({ json: result });
  });
  await page.goto(baseURL + "/sessions/limited/chat");
  return calls;
}

test.describe("in English", () => {
  test.use({ locale: "en-GB" });

  test("a session stopped at a limit offers a model change and a continue", async ({
    page,
  }) => {
    const calls = await fixture(page);
    const bar = page.getByRole("status", { name: "Usage limit reached" });
    await expect(bar).toBeVisible();
    await expect(bar).toContainText(detail);
    const composer = page.locator(".chat-composer textarea");
    await composer.fill("Keep this draft");

    await bar.getByRole("button", { name: "Change model", exact: true }).click();
    await expect(page.locator(".model-trigger")).toHaveAttribute("aria-expanded", "true");
    expect(calls.models).toEqual(["open"]);
    // Escape cancels the native picker as it does after a trigger click, once the
    // picker has moved focus to its options.
    await expect(page.getByRole("button", { name: "Fable", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator(".model-trigger")).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    await bar.getByRole("button", { name: "Continue", exact: true }).click();
    await expect.poll(() => calls.inputs.length).toBe(1);
    expect(calls.inputs[0]).toMatchObject({ text: "Please continue.", submit: true });
    await expect(composer).toHaveValue("Keep this draft");
  });

  test("Continue stays disabled while an attachment uploads", async ({ page }) => {
    let release;
    const uploadGate = new Promise((resolve) => {
      release = resolve;
    });
    await fixture(page, { uploadGate });
    const bar = page.getByRole("status", { name: "Usage limit reached" });
    const next = bar.getByRole("button", { name: "Continue", exact: true });
    await expect(next).toBeEnabled();
    await page.setInputFiles('input[type="file"]', {
      name: "note.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("note"),
    });
    await expect(next).toBeDisabled();
    release();
    await expect(next).toBeEnabled();
  });

  test("a session without a limit shows no limit bar", async ({ page }) => {
    await fixture(page, { limit: false });
    await expect(page.locator(".chat-composer textarea")).toBeVisible();
    await expect(page.locator(".chat-limit-bar")).toHaveCount(0);
  });
});

test("the limit bar speaks German", async ({ page }) => {
  await fixture(page);
  const bar = page.getByRole("status", { name: "Nutzungslimit erreicht" });
  await expect(bar).toContainText(detail);
  await expect(bar.getByRole("button", { name: "Modell wechseln" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Fortsetzen" })).toBeVisible();
});
