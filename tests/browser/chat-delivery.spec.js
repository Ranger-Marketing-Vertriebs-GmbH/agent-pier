import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

async function fixture(page, { mode = "success" } = {}) {
  const state = {
    session: {
      id: "delivery",
      accountId: "local-claude",
      tool: "claude",
      createdAt: "2026-09-08",
      name: "Delivery",
      cwd: "/fixture",
      status: "running",
    },
    messages: [],
    inputs: [],
    receipt: "absent",
    release: null,
  };
  state.publish = await mockChatStream(page, () => ({
    availability: "ready",
    messages: state.messages,
    tasks: [],
  }));
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.pathname === "/api/state")
      return route.fulfill({
        json: {
          tools: [{ id: "claude", name: "Claude Code", installed: true }],
          accounts: [],
          sessions: [state.session],
          home: "/fixture",
        },
      });
    if (url.pathname.endsWith("/chat"))
      return route.fulfill({
        json: { availability: "ready", messages: state.messages, tasks: [] },
      });
    if (url.pathname.endsWith("/chat/attachments"))
      return route.fulfill({
        json: { name: "notes.txt", path: "/fixture/uploads/notes.txt" },
      });
    if (url.pathname.endsWith("/input")) {
      const body = req.postDataJSON();
      state.inputs.push(body);
      if (mode === "slow")
        await new Promise((resolve) => {
          state.release = resolve;
        });
      state.receipt =
        mode === "offline" ? "absent" : mode === "uncertain" ? "uncertain" : "handed-off";
      if (mode !== "success" && mode !== "slow") return route.abort();
      return route.fulfill({
        json: { deliveryId: body.deliveryId, status: state.receipt },
      });
    }
    if (url.pathname.includes("/input/"))
      return route.fulfill({
        json: { deliveryId: url.pathname.split("/").at(-1), status: state.receipt },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto(baseURL + "/sessions/delivery/chat");
  await expect(page.getByLabel("Nachricht", { exact: true })).toBeVisible();
  return state;
}
const input = (page) => page.getByLabel("Nachricht", { exact: true });
const send = (page) => page.getByRole("button", { name: "Senden", exact: true });

test("mobile draft and completed upload survive reload and stay account scoped", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page);
  await input(page).fill("Mein mobiler Entwurf");
  await page.locator('input[type="file"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("notes"),
  });
  await expect(
    page.getByRole("button", { name: "Anhang entfernen: notes.txt" }),
  ).toBeVisible();
  await page.reload();
  await expect(input(page)).toHaveValue("Mein mobiler Entwurf");
  await expect(
    page.getByRole("button", { name: "Anhang entfernen: notes.txt" }),
  ).toBeVisible();
  expect(state.inputs).toHaveLength(0);
  state.session.accountId = "another-account";
  await page.reload();
  await expect(input(page)).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Anhang entfernen: notes.txt" }),
  ).toHaveCount(0);
});

test("message is immediately visible before ACK and merges into the native history", async ({
  page,
}) => {
  const state = await fixture(page, { mode: "slow" });
  await input(page).fill("Sofort sichtbar");
  await send(page).click();
  await expect(page.getByLabel("Chatverlauf")).toContainText("Sofort sichtbar");
  await expect(page.getByRole("status", { name: "Nachrichtenzustellung" })).toContainText(
    "Wird übergeben",
  );
  await expect.poll(() => Boolean(state.release)).toBe(true);
  state.release();
  await expect(page.getByRole("status", { name: "Nachrichtenzustellung" })).toContainText(
    "An Sitzung übergeben",
  );
  await expect(input(page)).toHaveValue("");
  state.messages.push({ id: "native-1", role: "user", text: "Sofort sichtbar" });
  state.publish();
  await expect(page.locator(".chat-delivery-message")).toHaveCount(0);
  await expect(
    page.getByRole("article", { name: "Deine Nachricht", exact: true }),
  ).toHaveCount(1);
});

test("lost ACK reconciles after reload without a second POST", async ({ page }) => {
  const state = await fixture(page, { mode: "lost-ack" });
  await input(page).fill("Nur einmal");
  await send(page).click();
  await expect.poll(() => state.inputs.length).toBe(1);
  await page.reload();
  await expect(input(page)).toHaveValue("");
  await expect(page.getByLabel("Chatverlauf")).toContainText("Nur einmal");
  await expect(page.getByRole("status", { name: "Nachrichtenzustellung" })).toContainText(
    "An Sitzung übergeben",
  );
  expect(state.inputs).toHaveLength(1);
});

test("absent receipt stays queued across reload and explicit retry reuses ID", async ({
  page,
}) => {
  const state = await fixture(page, { mode: "offline" });
  await input(page).fill("Später senden");
  await send(page).click();
  await expect.poll(() => state.inputs.length).toBe(1);
  await page.reload();
  await expect(page.getByRole("status", { name: "Nachrichtenzustellung" })).toContainText(
    "Wartet auf Übergabe",
  );
  expect(state.inputs).toHaveLength(1);
  await page.getByRole("button", { name: "Übergabe erneut versuchen" }).click();
  await expect.poll(() => state.inputs.length).toBe(2);
  expect(state.inputs[1]).toEqual(state.inputs[0]);
});

test("uncertain native input never retries automatically and needs explicit draft recovery", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page, { mode: "uncertain" });
  await input(page).fill("Vielleicht bereits übergeben");
  await send(page).click();
  await expect.poll(() => state.inputs.length).toBe(1);
  await page.reload();
  await expect(page.getByRole("status", { name: "Nachrichtenzustellung" })).toContainText(
    "Zustellung unklar",
  );
  await expect(input(page)).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Übergabe erneut versuchen" }),
  ).toHaveCount(0);
  await expect(
    page.getByText(/Neu zustellen prüft zuerst die TUI-Eingabe/),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/mobile-delivery-uncertain.png" });
  await page.getByRole("button", { name: "Nach Prüfung als Entwurf übernehmen" }).click();
  await expect(input(page)).toBeEnabled();
  await expect(input(page)).toHaveValue("Vielleicht bereits übergeben");
  expect(state.inputs).toHaveLength(1);
});

test("rapid typing keeps every character before reload", async ({ page }) => {
  await fixture(page);
  await input(page).pressSequentially("Schnell getippt, vollständig gespeichert.");
  await expect(input(page)).toHaveValue("Schnell getippt, vollständig gespeichert.");
  await page.reload();
  await expect(input(page)).toHaveValue("Schnell getippt, vollständig gespeichert.");
});

test("unavailable local storage retains text and never sends", async ({ page }) => {
  const state = await fixture(page);
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Full", "QuotaExceededError");
    };
  });
  await input(page).fill("Nicht verlieren");
  await expect(
    page.getByRole("alert").filter({ hasText: "nicht gespeichert" }),
  ).toBeVisible();
  await send(page).click();
  await expect(input(page)).toHaveValue("Nicht verlieren");
  await expect(page.locator(".chat-delivery-message")).toHaveCount(0);
  expect(state.inputs).toEqual([]);
});

test("missing message-ID support reports an error instead of silently dropping send", async ({
  page,
}) => {
  await page.addInitScript(() => {
    crypto.randomUUID = undefined;
  });
  const state = await fixture(page);
  await input(page).fill("Bleibt hier");
  await send(page).click();
  await expect(page.getByRole("alert")).toContainText("nicht vorbereitet");
  await expect(input(page)).toHaveValue("Bleibt hier");
  expect(state.inputs).toHaveLength(0);
});

test("legacy delivery cards stay expandable above current history while new sends remain visible", async ({
  page,
}) => {
  const state = await fixture(page);
  await input(page).fill("Old stored notice");
  await send(page).click();
  await expect(input(page)).toHaveValue("");
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith("agentpier.chat.v1:") || key.includes(":journal:")) continue;
      const value = JSON.parse(localStorage.getItem(key));
      for (const item of value.recent) delete item.clientCreatedAt;
      localStorage.setItem(key, JSON.stringify(value));
    }
  });
  state.messages = [
    { id: "current-answer", role: "assistant", text: "Latest native answer" },
  ];
  await page.reload();
  const saved = page.locator(".chat-delivery-saved");
  await expect(saved.locator("summary")).toContainText(
    "Gespeicherte Zustellungsanzeigen (1)",
  );
  await expect(page.getByText("Old stored notice", { exact: true })).not.toBeVisible();
  await expect(page.getByText("Latest native answer", { exact: true })).toBeVisible();
  await saved.locator("summary").click();
  await expect(saved).toContainText("Old stored notice");
  await expect(saved).toContainText("An Sitzung übergeben");
  await saved.locator("summary").click();
  await input(page).fill("Fresh outgoing message");
  await send(page).click();
  await expect(input(page)).toHaveValue("");
  await expect(page.getByText("Fresh outgoing message", { exact: true })).toBeVisible();
  expect(state.inputs).toHaveLength(2);
  await page.screenshot({ path: ".cache/chat-saved-notices.png" });
});

test("Claude absorbed mid-turn messages remove the handoff notice without another delivery", async ({
  page,
}) => {
  const { normalizeClaude } =
    await import("../../server/features/chat/history-parsers.js");
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page);
  const text = "Use the staging environment";
  await input(page).fill(text);
  await send(page).click();
  await expect(page.locator(".chat-delivery-message")).toHaveCount(1);
  const queue = { type: "queue-operation", operation: "enqueue", content: text };
  state.messages = normalizeClaude([queue]).messages;
  await state.publish();
  await expect(page.locator(".chat-delivery-message")).toHaveCount(1);
  state.messages = normalizeClaude([
    queue,
    {
      type: "attachment",
      uuid: "attachment",
      timestamp: "2026-09-12T06:21:51.917Z",
      attachment: {
        type: "queued_command",
        source_uuid: "human-message",
        prompt: text,
        commandMode: "prompt",
        origin: { kind: "human" },
      },
    },
  ]).messages;
  await state.publish();
  await expect(page.locator(".chat-delivery-message")).toHaveCount(0);
  await expect(page.locator(".chat-message.user")).toHaveCount(1);
  await expect(page.locator(".chat-message.user")).toContainText(text);
  await page.reload();
  await expect(page.locator(".chat-delivery-message")).toHaveCount(0);
  expect(state.inputs).toHaveLength(1);
});
