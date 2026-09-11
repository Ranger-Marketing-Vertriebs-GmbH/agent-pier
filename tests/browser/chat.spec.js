import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
test("mobile tasks open from the left without taking message height and close with Escape", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await page.goto(base + "/sessions/chat-demo/chat");
  await expect(page.getByLabel("Chatverlauf")).toContainText("Chatansicht");
  const before = await page.getByLabel("Chatverlauf").boundingBox();
  await page.getByRole("button", { name: "Aufgaben einblenden", exact: true }).click();
  const tasks = page.getByLabel("Aufgabenliste");
  await expect(tasks).toBeVisible();
  const box = await tasks.boundingBox();
  expect(box.width).toBeLessThanOrEqual(300);
  expect(box.x).toBeLessThanOrEqual(before.x);
  expect(box.height).toBeGreaterThan(400);
  expect((await page.getByLabel("Chatverlauf").boundingBox()).height).toBe(before.height);
  await expect(page.getByRole("dialog", { name: "Aufgabenliste" })).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  expect(
    await tasks.evaluate((element) => element.contains(document.activeElement)),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/agentpier-tasks-left-mobile.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(tasks).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Aufgaben einblenden", exact: true }),
  ).toBeFocused();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await expect(page).toHaveURL(/\/sessions\/chat-demo\/chat$/);
});
for (const height of [844, 500])
  test(`mobile chrome leaves room for messages at 390x${height}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height });
    const { sockets } = await fixture(page);
    await page.goto(base + "/sessions/chat-demo/reader");
    await expect(page.getByLabel("Chatverlauf")).toContainText("Chatansicht");
    const messages = await page.getByLabel("Chatverlauf").boundingBox(),
      composer = await page.locator(".chat-composer-shell").boundingBox();
    console.log(
      `Mobile 390x${height}: messages top=${messages.y}, height=${messages.height}, composer bottom=${composer.y + composer.height}`,
    );
    await page.screenshot({
      path: `test-results/mobile-chat-space-${height}.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(messages.y).toBeLessThanOrEqual(205);
    expect(messages.height).toBeGreaterThanOrEqual(height === 844 ? 430 : 105);
    expect(composer.y + composer.height).toBeLessThanOrEqual(height);
    expect(sockets).toHaveLength(0);
    await page.getByRole("button", { name: "Aufgaben einblenden", exact: true }).click();
    await expect(
      page.getByText("Mobile Darstellung prüfen", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Aufgaben schließen", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sitzung umbenennen" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sitzung stoppen" })).toBeVisible();
    await page.getByRole("button", { name: "Navigation öffnen" }).click();
    await expect(page.getByRole("navigation", { name: "Hauptnavigation" })).toBeVisible();
  });
async function fixture(page) {
  const session = {
    id: "chat-demo",
    name: "AgentPier entwickeln",
    tool: "claude",
    accountId: "local-claude",
    cwd: "/home/test/agentpier",
    status: "running",
  };
  const state = {
    tools: [{ id: "claude", name: "Claude Code", installed: true }],
    accounts: [
      { id: "local-claude", name: "Claude · Arbeit", tool: "claude", kind: "local" },
    ],
    sessions: [session],
    home: "/home/test",
    remoteUrl: null,
  };
  const data = {
    availability: "ready",
    providerSessionId: "native-one",
    messages: [
      {
        id: "u1",
        role: "user",
        text: "Baue eine klare Chatansicht und zeige die Aufgaben links.",
      },
      {
        id: "a1",
        role: "assistant",
        text: "Ich habe die **Chatansicht** eingebaut. Nachrichten bleiben auch auf dem Handy lesbar.\n\nDie Aufgabenliste zeigt den aktuellen Stand des CLI.",
      },
      {
        id: "t1",
        role: "tool",
        toolName: "Read",
        status: "completed",
        text: "web/ChatView.jsx\n\nexport default function ChatView() {\n  return <Chat />;\n}",
      },
      {
        id: "a2",
        role: "assistant",
        text: 'Als Nächstes prüfe ich das Layout bei schmalen Bildschirmen.\n\n```js\nconst mode = mobile ? "reader" : "terminal";\n```',
      },
    ],
    tasks: [
      {
        id: "one",
        text: "Nachrichten und Tool-Aktivitäten trennen",
        status: "completed",
      },
      { id: "two", text: "Mobile Darstellung prüfen", status: "in_progress" },
      { id: "three", text: "Installationsanleitung ergänzen", status: "pending" },
    ],
  };
  const publish = await mockChatStream(page, () => data);
  const inputs = [];
  const sockets = [];
  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    let result = {};
    if (p === "/api/state") result = state;
    else if (p.endsWith("/chat")) result = data;
    else if (p.endsWith("/input")) {
      const body = route.request().postDataJSON();
      inputs.push({ text: body.text, submit: body.submit });
      result = { deliveryId: body.deliveryId, status: "handed-off" };
    } else if (p.endsWith("/screen"))
      result = { text: "TUI_STATUS_ONLY auto mode on shift+tab to cycle" };
    else if (p.endsWith("/choices"))
      result = {
        choices: [
          { id: "native-one", title: "First" },
          { id: "native-two", title: "Second" },
        ],
      };
    else if (p.endsWith("/bind")) {
      Object.assign(data, {
        availability: "ready",
        providerSessionId: route.request().postDataJSON().providerSessionId,
        messages: [{ id: "bound", role: "assistant", text: "Verknüpfter Verlauf" }],
      });
      result = data;
    }
    await route.fulfill({ json: result });
  });
  await page.routeWebSocket("**/api/sessions/*/terminal", (ws) => {
    sockets.push(ws);
    ws.send(
      JSON.stringify({
        type: "output",
        data: "Änderungen · ❯ ● ▐▛███▜▌\r\nTUI_STATUS_ONLY\r\n❯\r\n──────────────────\r\nauto mode on (shift+tab to cycle)",
      }),
    );
  });
  return { data, inputs, sockets, publish };
}
test("reader has structured Markdown and live tasks on the left; native terminal remains intact", async ({
  page,
}) => {
  const { data, publish } = await fixture(page);
  await page.goto(base + "/#chat-demo");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByLabel("Chatverlauf")).toContainText("Chatansicht");
  await expect(page.locator(".message-content strong")).toHaveText("Chatansicht");
  await expect(page.getByLabel("Aufgabenliste")).toContainText(
    "Mobile Darstellung prüfen",
  );
  const tasks = await page.getByLabel("Aufgabenliste").boundingBox(),
    chat = await page.getByLabel("Chatverlauf").boundingBox();
  expect(tasks.x + tasks.width).toBeLessThanOrEqual(chat.x + 1);
  await expect(page.getByLabel("Chatverlauf")).not.toContainText("TUI_STATUS_ONLY");
  await expect(page.locator(".chat-tool pre")).not.toBeVisible();
  await page.locator(".chat-tool-group > summary").click();
  await page.locator(".chat-tool summary").click();
  await expect(page.locator(".chat-tool pre")).toContainText("return <Chat />;");
  data.tasks[1].status = "completed";
  publish();
  await expect(page.getByLabel("Aufgabenfortschritt")).toHaveAttribute("value", "2");
  await page.screenshot({
    path: "test-results/agentpier-chat-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.getByLabel("Interaktives Terminal")).toBeVisible();
  await expect(page.getByLabel("Aufgabenliste")).not.toBeVisible();
  await page.screenshot({
    path: "test-results/agentpier-unicode-terminal.png",
    fullPage: true,
    animations: "disabled",
  });
});
test("mobile defaults to chat, collapses tasks and sends to the running session without hidden terminal resize", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { inputs, sockets } = await fixture(page);
  await page.goto(base + "/#chat-demo");
  await expect(page.getByLabel("Chatverlauf")).toContainText("Nachrichten bleiben");
  expect(sockets.length).toBe(0);
  await expect(page.getByLabel("Aufgabenliste")).toBeHidden();
  await page.getByRole("button", { name: "Aufgaben einblenden", exact: true }).click();
  await expect(
    page.getByText("Mobile Darstellung prüfen", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Aufgaben schließen", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Nachricht", exact: true })
    .fill("Prüfe bitte die Änderungen.");
  await page.getByRole("button", { name: "Senden", exact: true }).click();
  await expect
    .poll(() => inputs)
    .toEqual([{ text: "Prüfe bitte die Änderungen.", submit: true }]);
  await expect(page.getByRole("textbox", { name: "Nachricht", exact: true })).toHaveValue(
    "",
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.locator(".chat-messages").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({
    path: "test-results/agentpier-chat-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
});
test("an unbound reader asks for the exact conversation and persists selected provider ID", async ({
  page,
}) => {
  const { data } = await fixture(page);
  Object.assign(data, {
    availability: "unbound",
    providerSessionId: null,
    messages: [],
    tasks: [],
  });
  await page.goto(base + "/#chat-demo");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Verlauf verknüpfen" })).toBeVisible();
  await page
    .getByRole("combobox", { name: "Unterhaltung", exact: true })
    .selectOption("native-two");
  await page.getByRole("button", { name: "Verknüpfen", exact: true }).click();
  await expect(page.getByLabel("Chatverlauf")).toContainText("Verknüpfter Verlauf");
  expect(data.providerSessionId).toBe("native-two");
  await page.reload();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByLabel("Chatverlauf")).toContainText("Verknüpfter Verlauf");
});
test("switching for a native approval keeps the draft, opened tool and reader scroll position", async ({
  page,
}) => {
  const { data } = await fixture(page);
  data.messages.push(
    ...Array.from({ length: 20 }, (_, i) => ({
      id: "long-" + i,
      role: "assistant",
      text: "Weitere Nachricht " + i + "\n\n" + "Lesbarer Inhalt. ".repeat(30),
    })),
  );
  await page.goto(base + "/#chat-demo");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByLabel("Chatverlauf")).toContainText("Weitere Nachricht 19");
  await page
    .getByRole("textbox", { name: "Nachricht", exact: true })
    .fill("Diesen Entwurf behalten");
  await page.locator(".chat-tool-group > summary").click();
  await page.locator(".chat-tool summary").click();
  await page.locator(".chat-messages").evaluate((el) => {
    el.scrollTop = 300;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.getByLabel("Interaktives Terminal")).toBeVisible();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Nachricht", exact: true })).toHaveValue(
    "Diesen Entwurf behalten",
  );
  await expect(page.locator(".chat-tool")).toHaveAttribute("open", "");
  await expect
    .poll(() => page.locator(".chat-messages").evaluate((el) => el.scrollTop))
    .toBe(300);
});

test("desktop Enter sends and Shift+Enter inserts a newline without submitting", async ({
  page,
}) => {
  const { inputs } = await fixture(page);
  await page.goto(base + "/#chat-demo");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "Nachricht", exact: true });
  await composer.fill("Erste Zeile");
  await composer.press("Shift+Enter");
  await composer.pressSequentially("Zweite Zeile");
  await expect(composer).toHaveValue("Erste Zeile\nZweite Zeile");
  expect(inputs).toEqual([]);
  await composer.press("Enter");
  await expect
    .poll(() => inputs)
    .toEqual([{ text: "Erste Zeile\nZweite Zeile", submit: true }]);
  await expect(composer).toHaveValue("");
  await composer.fill("Noch nicht senden");
  await composer.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
  });
  expect(inputs).toHaveLength(1);
  await expect(composer).toHaveValue("Noch nicht senden");
});
for (const width of [390, 844])
  test(`touch chat at ${width}px uses Enter for newlines and only the button sends`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    try {
      const { inputs } = await fixture(page);
      await page.goto(base + "/#chat-demo");
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      const composer = page.getByRole("textbox", { name: "Nachricht", exact: true });
      await composer.fill("Erste Zeile");
      await composer.press("Enter");
      await composer.pressSequentially("Zweite Zeile");
      await composer.press("Shift+Enter");
      await composer.pressSequentially("Dritte Zeile");
      await expect(composer).toHaveValue("Erste Zeile\nZweite Zeile\nDritte Zeile");
      expect(inputs).toEqual([]);
      await composer.press("Control+Enter");
      await composer.press("Meta+Enter");
      expect(inputs).toEqual([]);
      const message = await composer.inputValue();
      await page.getByRole("button", { name: "Senden", exact: true }).click();
      await expect.poll(() => inputs).toEqual([{ text: message, submit: true }]);
      await expect(composer).toHaveValue("");
    } finally {
      await context.close();
    }
  });
