import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { test, expect } from "@playwright/test";

import { baseURL as base } from "../helpers/browser.js";
async function fixture(page) {
  const session = {
    id: "model-demo",
    name: "Modell wechseln",
    tool: "codex",
    accountId: "local-codex",
    cwd: "/home/test/project",
    status: "running",
  };
  const state = {
    tools: [{ id: "codex", name: "Codex", installed: true }],
    accounts: [{ id: "local-codex", name: "Codex", tool: "codex", kind: "local" }],
    sessions: [session],
    home: "/home/test",
    remoteUrl: null,
  };
  const model = {
    currentModel: "gpt-5.6-sol",
    currentSource: "cli",
    picker: null,
    notice: null,
    pending: false,
  };
  const calls = [];
  const controls = {
    model,
    calls,
    failSelect: false,
    pendingSelect: false,
    holdNextGet: false,
    releaseGet: null,
    openOptions: null,
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body =
      route.request().method() === "POST" ? route.request().postDataJSON() : null;
    let result = {};
    if (path === "/api/state") result = state;
    else if (path.endsWith("/chat"))
      result = {
        availability: "ready",
        providerSessionId: "native-demo",
        messages: [{ id: "a1", role: "assistant", text: "Bestehende Unterhaltung" }],
        tasks: [],
      };
    else if (path.includes("/models")) {
      if (!body && controls.holdNextGet) {
        controls.holdNextGet = false;
        const previous = structuredClone(model);
        await new Promise((resolve) => {
          controls.releaseGet = resolve;
        });
        return route.fulfill({ json: previous });
      }
      if (body) calls.push({ action: path.split("/").at(-1), body });
      if (path.endsWith("/open"))
        model.picker = {
          token: "model-token",
          title: "Select Model and Effort",
          kind: "model",
          searchable: false,
          selected: "sol",
          options: [
            {
              id: "sol",
              label: "gpt-5.6-sol",
              description: "Aktuelles Modell",
              current: true,
            },
            {
              id: "astra",
              label: "gpt-6-astra",
              description: "Komplexe Aufgaben",
              current: false,
            },
          ],
        };
      if (path.endsWith("/open") && controls.openOptions)
        model.picker.options = controls.openOptions;
      if (path.endsWith("/select")) {
        if (controls.failSelect)
          return route.fulfill({
            status: 409,
            json: { error: "Die native Auswahl hat sich geändert." },
          });
        if (controls.pendingSelect)
          Object.assign(model, {
            picker: null,
            pending: true,
            notice: "Bitte bestätige die Auswahl im Terminal.",
          });
        else if (body.token === "model-token" && body.optionId === "astra")
          model.picker = {
            token: "effort-token",
            title: "Select Reasoning Level for gpt-6-astra",
            kind: "effort",
            searchable: false,
            selected: "medium",
            options: [
              { id: "medium", label: "Medium", description: "Ausgewogen", current: true },
              { id: "high", label: "High", description: "Gründlicher", current: false },
            ],
          };
        else if (body.token === "effort-token" && body.optionId === "high")
          Object.assign(model, {
            currentModel: "gpt-6-astra",
            currentSource: "confirmed",
            picker: null,
            pending: false,
          });
        else
          return route.fulfill({
            status: 400,
            json: { error: "Falsche Auswahl oder veraltetes Token." },
          });
      }
      if (path.endsWith("/cancel")) {
        if (body.token !== model.picker?.token)
          return route.fulfill({ status: 409, json: { error: "Veraltetes Token" } });
        model.picker = null;
      }
      if (path.endsWith("/search")) {
        if (body.token !== model.picker?.token || body.query !== "astra")
          return route.fulfill({ status: 409, json: { error: "Ungültige Suche" } });
        model.picker = {
          ...model.picker,
          token: "search-token",
          options: [
            {
              id: "astra",
              label: "gpt-6-astra",
              description: "Suchergebnis",
              current: false,
            },
          ],
        };
      }
      result = structuredClone(model);
    }
    await route.fulfill({ json: result });
  });
  await page.routeWebSocket("**/api/sessions/*/terminal", (ws) =>
    ws.send(JSON.stringify({ type: "output", data: "Native Unterhaltung\r\n" })),
  );
  await mockChatStream(page, () => ({
    availability: "ready",
    providerSessionId: "native-demo",
    messages: [{ id: "a1", role: "assistant", text: "Bestehende Unterhaltung" }],
    tasks: [],
  }));
  await page.goto(base + "/#model-demo");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  return controls;
}

test("model selection waits for native effort confirmation and preserves the draft", async ({
  page,
}) => {
  const { calls } = await fixture(page);
  const field = page.getByRole("button", { name: "Modell auswählen", exact: true });
  await expect(field).toContainText("gpt-5.6-sol");
  expect(calls).toEqual([]);
  const draft = page.getByRole("textbox", { name: "Nachricht", exact: true });
  await draft.fill("Diesen Entwurf behalten");
  await field.click();
  await expect(
    page.getByRole("button", { name: "gpt-6-astra", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/model-dropdown-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "gpt-6-astra", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Modellauswahl" })).toContainText(
    "Select Reasoning Level",
  );
  await expect(field).toContainText("gpt-5.6-sol");
  await expect(page.getByRole("button", { name: "Senden", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "High", exact: true }).click();
  await expect(field).toContainText("gpt-6-astra");
  await expect(page.getByText("Zuletzt bestätigt", { exact: true })).toBeVisible();
  await expect(draft).toHaveValue("Diesen Entwurf behalten");
  await expect(page.getByRole("button", { name: "Senden", exact: true })).toBeEnabled();
  expect(calls).toEqual([
    { action: "open", body: {} },
    { action: "select", body: { token: "model-token", optionId: "astra" } },
    { action: "select", body: { token: "effort-token", optionId: "high" } },
  ]);
});

test("model errors remain visible across polling and allow safe cancellation", async ({
  page,
}) => {
  const controls = await fixture(page);
  controls.failSelect = true;
  await page.getByRole("button", { name: "Modell auswählen", exact: true }).click();
  await page.getByRole("button", { name: "gpt-6-astra", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Die native Auswahl hat sich geändert",
  );
  controls.model.currentModel = "gpt-5.6-terra";
  await expect(
    page.getByRole("button", { name: "Modell auswählen", exact: true }),
  ).toContainText("gpt-5.6-terra");
  await expect(page.getByRole("alert")).toContainText(
    "Die native Auswahl hat sich geändert",
  );
  await page.getByRole("button", { name: "Auswahl abbrechen", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Modellauswahl" })).not.toBeVisible();
  expect(controls.calls.at(-1)).toEqual({
    action: "cancel",
    body: { token: "model-token" },
  });
});

test("model refresh reflects external changes and pending native confirmation offers terminal", async ({
  page,
}) => {
  const controls = await fixture(page);
  Object.assign(controls.model, { currentModel: "gpt-5.6-terra", currentSource: "cli" });
  await expect(
    page.getByRole("button", { name: "Modell auswählen", exact: true }),
  ).toContainText("gpt-5.6-terra", { timeout: 6000 });
  controls.pendingSelect = true;
  await page.getByRole("button", { name: "Modell auswählen", exact: true }).click();
  await page.getByRole("button", { name: "gpt-6-astra", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Modellauswahl" })).toContainText(
    "Bitte bestätige die Auswahl im Terminal.",
  );
  await page.getByRole("button", { name: "Im Terminal fortfahren", exact: true }).click();
  await expect(page.getByLabel("Interaktives Terminal")).toBeVisible();
});

test("mobile model picker supports touch and keyboard without overflowing", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await fixture(page);
    await page.getByRole("button", { name: "Modell auswählen", exact: true }).tap();
    await page.getByRole("button", { name: "gpt-6-astra", exact: true }).tap();
    const option = page.getByRole("button", { name: "High", exact: true });
    await option.focus();
    await option.press("Enter");
    await expect(
      page.getByRole("button", { name: "Modell auswählen", exact: true }),
    ).toContainText("gpt-6-astra");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
  } finally {
    await context.close();
  }
});

test("an older model poll cannot overwrite an in-progress native picker", async ({
  page,
}) => {
  const controls = await fixture(page);
  controls.holdNextGet = true;
  await expect.poll(() => Boolean(controls.releaseGet), { timeout: 6000 }).toBe(true);
  await page.getByRole("button", { name: "Modell auswählen", exact: true }).click();
  await page.getByRole("button", { name: "gpt-6-astra", exact: true }).click();
  controls.releaseGet();
  await expect(page.getByRole("dialog", { name: "Modellauswahl" })).toContainText(
    "Select Reasoning Level",
  );
  await page.getByRole("button", { name: "High", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Modell auswählen", exact: true }),
  ).toContainText("gpt-6-astra");
});

test("search uses the displayed native picker token and renders its returned options", async ({
  page,
}) => {
  const controls = await fixture(page);
  controls.model.picker = {
    token: "native-search",
    title: "Select model",
    kind: "model",
    searchable: true,
    selected: "sol",
    options: [{ id: "sol", label: "gpt-5.6-sol", description: "Current", current: true }],
  };
  await page.getByRole("textbox", { name: "Modelle suchen", exact: true }).fill("astra");
  await page.getByRole("button", { name: "Suchen", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "gpt-6-astra", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "gpt-5.6-sol", exact: true }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "Auswahl abbrechen", exact: true }).click();
  expect(controls.calls.at(-1)).toEqual({
    action: "cancel",
    body: { token: "search-token" },
  });
});

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
  { width: 390, height: 500 },
])
  test(`model field stays attached to composer and picker opens within the chat at ${viewport.width}x${viewport.height}`, async ({
    browser,
  }) => {
    const resized = viewport.height === 500;
    const context = await browser.newContext({
      viewport: resized ? { ...viewport, height: 844 } : viewport,
      hasTouch: viewport.width < 700,
      isMobile: viewport.width < 700,
    });
    try {
      const page = await context.newPage();
      const controls = await fixture(page);
      controls.openOptions = Array.from({ length: 16 }, (_, index) => ({
        id: `model-${index}`,
        label: `Model ${index}`,
        description:
          "A model with a longer description to exercise the scrollable picker.",
        current: index === 0,
      }));
      const trigger = page.getByRole("button", { name: "Modell auswählen", exact: true });
      const draft = page.getByRole("textbox", { name: "Nachricht", exact: true });
      await draft.fill("Entwurf bleibt erhalten");
      await expect(trigger).toHaveCount(1);
      const field = await trigger.boundingBox(),
        messages = await page.getByLabel("Chatverlauf").boundingBox(),
        composer = await page
          .locator(viewport.width < 700 ? ".chat-composer-shell" : ".chat-composer")
          .boundingBox();
      expect(field.y).toBeGreaterThanOrEqual(messages.y + messages.height - 1);
      if (viewport.width < 700) {
        expect(field.y).toBeGreaterThanOrEqual(composer.y);
        expect(field.y + field.height).toBeLessThanOrEqual(composer.y + composer.height);
      } else {
        expect(composer.y - (field.y + field.height)).toBeGreaterThanOrEqual(0);
        expect(composer.y - (field.y + field.height)).toBeLessThanOrEqual(20);
      }
      await trigger.click();
      const picker = page.getByRole("dialog", { name: "Modellauswahl" });
      await expect(picker).toBeVisible();
      await expect(
        picker.getByRole("button", { name: "Model 15", exact: true }),
      ).toBeAttached();
      if (resized) {
        await page.setViewportSize(viewport);
        await expect
          .poll(async () => {
            const form = await page.locator(".chat-composer-shell").boundingBox(),
              layout = await page.locator(".chat-layout").boundingBox();
            return form.y + form.height <= layout.y + layout.height;
          })
          .toBe(true);
      }
      // Read every bound in one browser task; resize/scroll can otherwise advance
      // between individual protocol calls and combine different layout frames.
      await expect(async () => {
        const { panel, anchor, chat, scrollable } = await picker.evaluate((element) => {
          const rect = (node) => node.getBoundingClientRect().toJSON();
          return {
            panel: rect(element),
            anchor: rect(
              element.closest(".model-control").querySelector(".model-trigger"),
            ),
            chat: rect(element.closest(".chat-layout")),
            scrollable: element.scrollHeight > element.clientHeight,
          };
        });
        expect(panel.bottom).toBeLessThanOrEqual(anchor.top);
        expect(panel.top).toBeGreaterThanOrEqual(Math.max(0, chat.top));
        expect(panel.left).toBeGreaterThanOrEqual(0);
        expect(panel.right).toBeLessThanOrEqual(viewport.width);
        expect(scrollable).toBe(true);
      }).toPass({ timeout: 5000 });
      await page
        .getByRole("button", { name: "Auswahl abbrechen", exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `test-results/model-composer-${viewport.width}x${viewport.height}.png`,
        fullPage: true,
        animations: "disabled",
      });
      await page.getByRole("button", { name: "Auswahl abbrechen", exact: true }).click();
      await expect(picker).not.toBeVisible();
      await expect(draft).toHaveValue("Entwurf bleibt erhalten");
      expect(controls.calls.map((call) => call.action)).toEqual(["open", "cancel"]);
      await page.screenshot({
        path: `test-results/model-composer-closed-${viewport.width}x${viewport.height}.png`,
        fullPage: true,
        animations: "disabled",
      });
      expect(await page.locator("form form").count()).toBe(0);
    } finally {
      await context.close();
    }
  });

test("a blocked mobile model switch shows its reason without a contradictory terminal instruction", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await page.route("**/api/sessions/*/models/open", (route) =>
    route.fulfill({
      status: 409,
      json: {
        error:
          "Die Modellauswahl ist gerade nicht verfügbar. Bitte eine offene Freigabe oder die Terminal-Eingabe prüfen.",
      },
    }),
  );
  await page.getByRole("button", { name: "Modell auswählen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Modellauswahl" });
  await expect(dialog.getByRole("alert")).toContainText("Terminal-Eingabe prüfen");
  await expect(
    dialog.getByText("Öffne die Modellauswahl im Terminal, um fortzufahren.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Modellauswahl schließen" }).click();
  await expect(dialog).toHaveCount(0);
  await page.unroute("**/api/sessions/*/models/open");
  await page.getByRole("button", { name: "Modell auswählen", exact: true }).click();
  await expect(page.locator(".model-option").first()).toBeVisible();
});
