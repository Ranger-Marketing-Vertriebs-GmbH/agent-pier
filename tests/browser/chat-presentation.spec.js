import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

async function fixture(
  page,
  { observability, activity = "working", repositoryName } = {},
) {
  const session = {
    id: "presentation",
    name: "Presentation session",
    accountId: "local-codex",
    tool: "codex",
    cwd: "/fixture/projects/website",
    repositoryName,
    status: "running",
    activity: { state: activity },
  };
  const data = {
    availability: "ready",
    messages: [
      { id: "short", role: "user", text: "Hello" },
      {
        id: "long",
        role: "user",
        text:
          "Long text " +
          "word".repeat(300) +
          "\n\n```js\n" +
          "const item = 1; ".repeat(60) +
          "\n```",
      },
      { id: "reply", role: "assistant", text: "A response." },
    ],
    tasks: [],
    observability,
  };
  await page.route("**/api/**", (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === "/api/state")
      return route.fulfill({
        json: {
          tools: [{ id: "codex", name: "Codex", installed: true }],
          accounts: [{ id: "local-codex", name: "Codex", tool: "codex", kind: "local" }],
          sessions: [session],
          home: "/fixture",
        },
      });
    if (path.endsWith("/chat")) return route.fulfill({ json: data });
    if (path.endsWith("/models"))
      return route.fulfill({
        json: { currentModel: null, picker: null, pending: false },
      });
    throw new Error(`Unexpected presentation fixture request: ${path}`);
  });
  await page.goto(baseURL + "/sessions/presentation/chat");
  await expect(page.getByLabel("Chatverlauf")).toContainText("A response.");
  return { session, data };
}

for (const width of [1440, 390])
  test(`user bubbles fit content, align right, and keep long content bounded at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await fixture(page);
    const messages = page.getByRole("article", { name: "Deine Nachricht", exact: true });
    const short = await messages.first().boundingBox(),
      long = await messages.nth(1).boundingBox(),
      area = await page.getByLabel("Chatverlauf").boundingBox();
    expect(short.width).toBeLessThan(160);
    expect(short.x).toBeGreaterThan(area.x + area.width / 2);
    expect(long.x + long.width).toBeLessThanOrEqual(area.x + area.width);
    expect(long.width).toBeLessThanOrEqual(area.width * (width < 700 ? 0.95 : 0.85));
    await expect(messages.locator(".message-byline")).toHaveCount(0);
    await expect(page.getByText("Du", { exact: true })).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
  });

for (const width of [390, 1440])
  test(`chat spinner follows working and waiting states at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const { session } = await fixture(page);
    const status = page.getByRole("status", { name: "Sitzungsaktivität" });
    const tab = page.getByRole("button", { name: "Chat", exact: true });
    await expect(status).toContainText("Arbeitet");
    await expect(tab.locator(".chat-working-spinner")).toBeVisible();
    await expect(status.locator(".chat-working-spinner")).toBeVisible();
    await expect(tab.locator(".chat-working-spinner")).toHaveCSS(
      "animation-name",
      "chat-working-spin",
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(tab.locator(".chat-working-spinner")).toHaveCSS(
      "animation-name",
      "none",
    );
    session.activity.state = "waiting";
    await expect(status).toContainText("Wartet");
    await expect(page.locator(".chat-working-spinner")).toHaveCount(0);
    session.activity.state = "working";
    await expect(tab.locator(".chat-working-spinner")).toBeVisible();
    session.status = "stopped";
    await expect(page.locator(".chat-working-spinner")).toHaveCount(0);
  });

test("snapshot context preserves last-request provenance and labels configured limits separately", async ({
  page,
}) => {
  await fixture(page, {
    observability: {
      stale: true,
      context: {
        usedTokens: 12800,
        limitTokens: 100000,
        remainingPercent: 87.2,
        source: "last-api-request",
        limitSource: "configured",
        observedAt: "2026-09-06T10:00:00Z",
      },
      subagents: [],
    },
  });
  const context = page.getByRole("group", { name: "Kontextbudget" });
  await expect(context).toContainText("12.800");
  await expect(context).toContainText("100.000");
  await expect(context).toContainText("Letzte API-Anfrage");
  await expect(context).toContainText("Konfiguriertes Limit");
  await expect(context).toContainText("87,2 % verbleibend");
  await expect(context).toContainText("Gespeicherter Stand");
});

test("unknown usage remains unknown while a native limit may be shown independently", async ({
  page,
}) => {
  const { data } = await fixture(page, {
    observability: {
      context: {
        usedTokens: null,
        limitTokens: 200000,
        remainingPercent: null,
        source: null,
        limitSource: "native",
        observedAt: null,
      },
      subagents: [],
    },
  });
  const context = page.getByRole("group", { name: "Kontextbudget" });
  await expect(context).toContainText("Kontextverbrauch nicht verfügbar");
  await expect(context).toContainText("200.000");
  await expect(context).not.toContainText("0 /");
  await expect(context).not.toContainText("%");
  data.observability.context = {
    usedTokens: null,
    limitTokens: null,
    remainingPercent: null,
    source: null,
    limitSource: null,
    observedAt: null,
  };
  await expect(context).not.toContainText("200.000");
  await expect(context).toContainText("Kontextverbrauch nicht verfügbar");
});

test("mobile task drawer shows only active subagents with their task immediately visible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, {
    observability: {
      context: { usedTokens: null, limitTokens: null, source: null },
      subagents: [
        {
          id: "native-alpha",
          name: "Worker alpha",
          task: "Inspect build configuration",
          status: "running",
          source: "native-task",
          updatedAt: "2026-09-06T10:00:00Z",
        },
        {
          id: "native-beta",
          name: "Worker beta",
          task: "Review styles",
          status: "completed",
          source: "native-task",
          updatedAt: "2026-09-06T10:00:00Z",
        },
      ],
    },
  });
  await page.getByRole("button", { name: "Unteragenten anzeigen" }).click();
  const drawer = page.getByRole("dialog", { name: "Aufgabenliste" });
  await expect(drawer).toBeVisible();
  await expect(
    drawer.getByText("Inspect build configuration", { exact: true }),
  ).toBeVisible();
  await expect(drawer).toContainText("Arbeitet");
  await expect(drawer).not.toContainText("Worker beta");
  await expect(drawer.locator(".subagent-entry")).toHaveCount(1);
  await expect(
    drawer.getByRole("heading", { name: "Aktive Unteragenten (1)" }),
  ).toBeVisible();
  await page.screenshot({ path: "docs/screenshots/active-subagents.png" });
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(page.getByRole("button", { name: "Unteragenten anzeigen" })).toBeFocused();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test("subagent count and visible tasks follow live updates and disappear on completion", async ({
  page,
}) => {
  const { data } = await fixture(page, {
    observability: {
      subagents: [
        { id: "active", name: "Reviewer", task: "Check the API", status: "running" },
        ...["completed", "failed", "unknown"].map((status) => ({
          id: status,
          name: status,
          status,
        })),
      ],
    },
  });
  const count = page.getByRole("button", { name: "Unteragenten anzeigen" });
  await expect(count).toHaveText("Aktive Unteragenten (1)");
  await count.click();
  const panel = page.getByRole("complementary", { name: "Aufgabenliste" });
  await expect(panel.locator(".subagent-entry")).toHaveCount(1);
  await expect(panel.getByText("Check the API", { exact: true })).toBeVisible();
  data.observability.subagents[0].task = "Verify the error handling";
  await expect(
    panel.getByText("Verify the error handling", { exact: true }),
  ).toBeVisible();
  data.observability.subagents[0].status = "completed";
  await expect(count).toHaveCount(0);
  await expect(panel.locator(".subagent-entry")).toHaveCount(0);
});

for (const mode of ["stale", "stopped"]) {
  test(`historical running subagents are hidden when ${mode}`, async ({ page }) => {
    const { session, data } = await fixture(page, {
      observability: {
        subagents: [
          { id: "active", name: "Old worker", task: "Old task", status: "running" },
        ],
      },
    });
    const count = page.getByRole("button", { name: "Unteragenten anzeigen" });
    await expect(count).toBeVisible();
    if (mode === "stale") data.observability.stale = true;
    else session.status = "stopped";
    await expect(count).toHaveCount(0);
    await expect(page.locator(".subagent-entry")).toHaveCount(0);
  });
}

test("session rows show a bounded directory and remain collapsible", async ({ page }) => {
  await fixture(page);
  const directory = page.locator(".session-directory");
  await expect(directory).toHaveText("/fixture/projects/website");
  const bounds = await directory.evaluate((element) => ({
    overflow: getComputedStyle(element).textOverflow,
    whitespace: getComputedStyle(element).whiteSpace,
  }));
  expect(bounds).toEqual({ overflow: "ellipsis", whitespace: "nowrap" });
  await page.getByRole("button", { name: "Sitzungen", exact: true }).click();
  await expect(directory).toBeHidden();
});

test("mobile chat input keeps a focus-safe font size and fits the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  const input = page.getByRole("textbox", { name: "Nachricht", exact: true });
  await input.focus();
  expect(
    await input.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
  ).toBeGreaterThanOrEqual(16);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test("mobile chat keeps compact composer controls together above the keyboard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  const add = page.getByRole("button", { name: "Datei hinzufügen", exact: true });
  const model = page.getByRole("button", { name: "Modell auswählen", exact: true });
  const send = page.getByRole("button", { name: "Senden", exact: true });
  const a = await add.boundingBox(),
    m = await model.boundingBox(),
    s = await send.boundingBox();
  expect(Math.abs(a.y - m.y)).toBeLessThan(8);
  expect(Math.abs(a.y - s.y)).toBeLessThan(8);
  expect((await page.locator(".chat-composer-shell").boundingBox()).height).toBeLessThan(
    160,
  );
  await expect(page.getByRole("group", { name: "Kontextbudget" })).toBeHidden();
  await page.getByRole("button", { name: "Kontextdetails anzeigen" }).click();
  await expect(page.getByRole("group", { name: "Kontextbudget" })).toBeVisible();
  await page.getByRole("button", { name: "Kontextdetails ausblenden" }).click();
  await page.screenshot({ path: "/tmp/agentpier-chat-compact.png" });
  await page
    .getByRole("textbox", { name: "Nachricht", exact: true })
    .fill("Eine Nachricht\nmit zweiter Zeile");
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, "height", {
      configurable: true,
      value: 420,
    });
    window.visualViewport.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(async () => {
      const rect = await page.locator(".chat-composer-shell").boundingBox();
      return rect.y + rect.height;
    })
    .toBeLessThanOrEqual(420);
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, "height", {
      configurable: true,
      value: 0,
    });
    window.visualViewport.dispatchEvent(new Event("resize"));
  });
  expect((await page.locator(".app").boundingBox()).height).toBe(420);
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, "height", {
      configurable: true,
      value: 844,
    });
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await expect
    .poll(async () => (await page.locator(".app").boundingBox()).height)
    .toBe(844);
  await page.getByRole("button", { name: "Navigation öffnen", exact: true }).click();
  await expect(page.locator(".sidebar")).toHaveClass(/open/);
});

for (const following of [true, false])
  test(`keyboard resize preserves ${following ? "the latest message" : "the reading position"}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await fixture(page);
    // Freeze subsequent transcript reads so polling cannot accidentally repair a
    // lost scroll position and hide the keyboard-resize regression.
    await page.route("**/api/sessions/presentation/chat", () => {});
    const messages = page.getByLabel("Chatverlauf");
    await messages.evaluate((element, bottom) => {
      element.scrollTop = bottom ? element.scrollHeight : 120;
    }, following);
    // Let the real scroll event finish before opening the keyboard; changing
    // both in one frame would conflate user scrolling with viewport resizing.
    await messages.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect
      .poll(() => messages.evaluate((el) => Math.round(el.scrollTop)))
      .toBeGreaterThan(0);
    await page.getByRole("textbox", { name: "Nachricht", exact: true }).focus();
    const before = await messages.evaluate((el) => el.scrollTop);
    for (const height of [650, 500, 420, 844]) {
      await page.evaluate((height) => {
        Object.defineProperty(window.visualViewport, "height", {
          configurable: true,
          value: height,
        });
        window.visualViewport.dispatchEvent(new Event("resize"));
      }, height);
      await expect
        .poll(() =>
          messages.evaluate((el) => ({
            gap: el.scrollHeight - el.clientHeight - el.scrollTop,
            top: el.scrollTop,
          })),
        )
        .toMatchObject(following ? { gap: 0 } : { top: before });
    }
  });

test("returning to the app recovers a suspended chat request and preserves the draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { data } = await fixture(page);
  const input = page.getByRole("textbox", { name: "Nachricht", exact: true });
  await input.fill("Mein ungesendeter Entwurf");
  let stalled = false;
  await page.route("**/api/sessions/presentation/chat", (route) => {
    if (!stalled) {
      stalled = true;
      return;
    }
    return route.fulfill({
      json: {
        ...data,
        messages: [
          { id: "resumed", role: "assistant", text: "Nach Rückkehr aktualisiert" },
        ],
      },
    });
  });
  await expect.poll(() => stalled).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await expect(page.getByLabel("Chatverlauf")).toContainText(
    "Nach Rückkehr aktualisiert",
  );
  await expect(input).toHaveValue("Mein ungesendeter Entwurf");
});

test("mobile connection errors leave the composer reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await page.route("**/api/state", (route) =>
    route.fulfill({ status: 503, json: { error: "Verbindung unterbrochen" } }),
  );
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
  );
  await expect(page.locator(".global-error")).toBeVisible();
  const composer = await page.locator(".chat-composer-shell").boundingBox();
  expect(composer.y + composer.height).toBeLessThanOrEqual(844);
});

test("Claude dashboard mark uses a vector instead of a platform-dependent emoji", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: {
        tools: [{ id: "claude", name: "Claude Code", installed: true }],
        accounts: [],
        sessions: [],
        home: "/fixture",
      },
    }),
  );
  await page.goto(baseURL);
  const mark = page.locator(".tool-card .provider-mark.claude");
  await expect(mark.locator("svg")).toBeVisible();
  await expect(mark).toHaveText("");
  await page.screenshot({ path: "/tmp/agentpier-mobile-claude.png" });
});

test("session rows show the CLI mark and repository name with the full path available", async ({
  page,
}) => {
  await fixture(page, { repositoryName: "website" });
  const row = page.locator(".session-item");
  await expect(row.locator(".provider-mark.codex svg")).toBeVisible();
  await expect(row.locator(".session-directory")).toHaveText("website");
  await expect(row.locator(".session-directory")).toHaveAttribute(
    "title",
    "/fixture/projects/website",
  );
  await expect(page.locator(".session-footer")).toContainText("website");
  await page.screenshot({ path: "/tmp/agentpier-session-labels.png" });
});
