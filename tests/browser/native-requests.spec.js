import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";
const request = {
  id: "request-one",
  sessionId: "fixture-session",
  kind: "question",
  revision: 1,
  status: "pending",
  source: "codex",
  createdAt: "2026-09-07T12:00:00Z",
  questions: [
    {
      id: "question-one",
      prompt: "Choose a scope",
      options: [
        { id: "tests", label: "Tests", description: "Run the test suite" },
        { id: "docs", label: "Docs" },
      ],
      multiple: true,
      allowOther: true,
    },
    {
      id: "question-two",
      prompt: "Choose a target",
      options: [{ id: "local", label: "Local" }],
      multiple: false,
      allowOther: true,
    },
  ],
};
test("native questions require all answers and retain drafts on conflict without sending ordinary chat", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  state.requests = [request];
  await page.goto(baseURL + "/sessions/fixture-session/chat");
  await expect(page.getByText("Choose a scope", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Nachricht", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Modell auswählen", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Antwort senden", exact: true }).click();
  expect(state.calls.some((call) => call.path.endsWith("/answer"))).toBe(false);
  await page.getByLabel("Tests", { exact: true }).check();
  await page.getByLabel("Docs", { exact: true }).check();
  await page.getByLabel("Local", { exact: true }).check();
  state.fail = "/sessions/fixture-session/requests/request-one/answer";
  await page.getByRole("button", { name: "Antwort senden", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Fixture conflict");
  await expect(page.getByLabel("Tests", { exact: true })).toBeChecked();
  state.fail = "";
  await page.getByRole("button", { name: "Antwort senden", exact: true }).click();
  await expect(page.getByText("Choose a scope", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Nachricht", exact: true }),
  ).toBeEnabled();
  expect(state.calls.filter((call) => call.path.endsWith("/answer")).at(-1).body).toEqual(
    {
      expectedRevision: 1,
      answers: { "question-one": ["tests", "docs"], "question-two": ["local"] },
    },
  );
  expect(
    state.calls.some((call) => call.method === "POST" && call.path.endsWith("/chat")),
  ).toBe(false);
});
test("mobile permission request preserves native options and unknown outcomes offer only Terminal", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await operationsFixture(page);
  state.requests = [
    {
      ...request,
      kind: "permission",
      questions: undefined,
      subject: { command: "command ".repeat(80), cwd: "/fixture/project" },
      options: [
        { id: "once", label: "Allow once", scope: "once" },
        { id: "deny", label: "Deny" },
      ],
    },
  ];
  await page.goto(baseURL + "/sessions/fixture-session/chat");
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(
    0,
  );
  expect(state.calls.find((call) => call.path.endsWith("/answer")).body).toEqual({
    expectedRevision: 1,
    choice: "once",
  });
  state.requests = [{ ...request, status: "unknown" }];
  await page.reload();
  await expect(
    page.getByText("Zustellung unklar. Im Terminal prüfen.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Antwort senden", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});
test("secret native answers stay masked and a new occurrence resets the draft", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  const secretQuestion = {
    id: "q0",
    prompt: "Fixture access phrase",
    options: [],
    multiple: false,
    allowOther: true,
    secret: true,
  };
  state.requests = [{ ...request, questions: [secretQuestion] }];
  await page.goto(baseURL + "/sessions/fixture-session/chat");
  const input = page.locator('input[type="password"]');
  await input.fill("fixture secret");
  expect(await input.getAttribute("autocomplete")).toBe("off");
  state.requests = [{ ...request, id: "request-two", questions: [secretQuestion] }];
  await expect(input).toHaveValue("");
  expect(await page.evaluate(() => Object.values(localStorage).join(" "))).not.toContain(
    "fixture secret",
  );
  await input.fill("replacement fixture");
  state.hold = "/sessions/fixture-session/requests/request-two/answer";
  await page.getByRole("button", { name: "Antwort senden", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Antwort senden", exact: true }),
  ).toBeDisabled();
  expect(state.calls.filter((call) => call.path.endsWith("/answer"))).toHaveLength(1);
  state.release();
  await expect(input).toHaveCount(0);
  expect(state.calls.find((call) => call.path.endsWith("/answer")).body.answers).toEqual({
    q0: ["replacement fixture"],
  });
});
test("short mobile native request controls stay inside the workspace and remain actionable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 500 });
  const state = await operationsFixture(page);
  state.requests = [
    {
      ...request,
      kind: "permission",
      questions: undefined,
      subject: { command: "fixture command ".repeat(80) },
      options: [{ id: "allow", label: "Allow once" }],
    },
  ];
  await page.goto(baseURL + "/sessions/fixture-session/chat");
  await expect(
    page.getByRole("button", { name: "Allow once", exact: true }),
  ).toBeVisible();
  const area = await page.locator(".chat-compose-area").boundingBox();
  const workspace = await page.locator(".chat-main").boundingBox();
  expect(area.y + area.height).toBeLessThanOrEqual(workspace.y + workspace.height);
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Nachricht", exact: true }),
  ).toBeEnabled();
});

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 500 },
]) {
  test(`Claude questions can be answered in Terminal at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.routeWebSocket("**/api/sessions/*/terminal", (socket) => {
      socket.send(JSON.stringify({ type: "output", data: "Fixture terminal ready\r\n" }));
    });
    const state = await operationsFixture(page);
    await page.goto(baseURL + "/sessions/fixture-session/terminal");
    await expect(page.locator(".terminal-mount .xterm")).toBeVisible();
    state.requests = [{ ...request, source: "claude" }];
    const panel = page.locator(".terminal-pane .native-requests");
    await expect(panel.getByText("Choose a scope", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(
      page
        .locator(".chat-container .native-requests")
        .getByText("Choose a scope", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await expect(panel.getByText("Choose a scope", { exact: true })).toBeVisible();
    const terminal = await page.locator(".terminal-mount").boundingBox();
    const bounds = await panel.boundingBox();
    expect(terminal.height).toBeGreaterThan(40);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(terminal.y);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(viewport.width);
    await panel.getByLabel("Tests", { exact: true }).check();
    await panel.getByLabel("Local", { exact: true }).check();
    await panel.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: testInfo.outputPath("terminal-question.png") });
    await panel.getByRole("button", { name: "Antwort senden", exact: true }).click();
    await expect(panel).toHaveCount(0);
    expect(state.calls.find((call) => call.path.endsWith("/answer")).body).toEqual({
      expectedRevision: 1,
      answers: { "question-one": ["tests"], "question-two": ["local"] },
    });
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.getByText("Choose a scope", { exact: true })).toHaveCount(0);
  });
}

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(`Codex startup trust ${locale}`, () => {
    test.use({ locale });
    test("mobile chat preserves a draft while approving startup hooks", async ({
      page,
    }) => {
      const en = locale === "en-GB";
      await page.setViewportSize({ width: 390, height: 844 });
      const state = await operationsFixture(page);
      await page.goto(baseURL + "/sessions/fixture-session/chat");
      const input = page.getByRole("textbox", {
        name: en ? "Message" : "Nachricht",
        exact: true,
      });
      await expect(input).toBeEnabled();
      await input.fill("Keep this original draft");
      state.requests = [
        {
          id: "hooks",
          sessionId: "fixture-session",
          revision: 1,
          status: "pending",
          source: "codex",
          kind: "permission",
          presentation: "codexHookTrust",
          hookCount: 2,
          subject: { command: "echo fixture", cwd: "/fixture" },
          options: [
            { id: "trust", label: "Trust all and continue", scope: "persistent" },
            { id: "skip", label: "Continue without trusting" },
          ],
        },
      ];
      await expect(
        page.getByText(en ? "Review Codex hooks" : "Codex-Hooks prüfen", { exact: true }),
      ).toBeVisible();
      await expect(input).toBeDisabled();
      await expect(input).toHaveValue("Keep this original draft");
      expect(state.calls.some((c) => c.path.endsWith("/answer"))).toBe(false);
      if (en)
        await page
          .locator(".chat-container .native-requests")
          .screenshot({ path: test.info().outputPath("codex-hook-trust-mobile.png") });
      await page
        .getByRole("button", {
          name: en ? "Trust hooks and continue" : "Hooks vertrauen und fortfahren",
          exact: true,
        })
        .click();
      await expect(input).toBeEnabled();
      await expect(input).toHaveValue("Keep this original draft");
      expect(state.calls.filter((c) => c.path.endsWith("/answer")).at(-1).body).toEqual({
        expectedRevision: 1,
        choice: "trust",
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
    });
  });
}

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(`Claude folder trust ${locale}`, () => {
    test.use({ locale });
    test("mobile folder approval preserves the original draft", async ({ page }) => {
      const en = locale === "en-GB";
      await page.setViewportSize({ width: 390, height: 844 });
      const state = await operationsFixture(page);
      await page.goto(baseURL + "/sessions/fixture-session/chat");
      const input = page.getByRole("textbox", {
        name: en ? "Message" : "Nachricht",
        exact: true,
      });
      await expect(input).toBeEnabled();
      await input.fill("Keep my Claude message");
      state.requests = [
        {
          id: "folder",
          sessionId: "fixture-session",
          revision: 1,
          status: "pending",
          source: "claude",
          kind: "permission",
          presentation: "claudeFolderTrust",
          subject: { path: "/workspace/project" },
          options: [
            { id: "trust", label: "Yes, I trust this folder", scope: "persistent" },
            { id: "exit", label: "No, exit" },
          ],
        },
      ];
      await expect(
        page.getByText(en ? "Trust Claude workspace" : "Claude-Arbeitsordner vertrauen", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(input).toBeDisabled();
      await expect(input).toHaveValue("Keep my Claude message");
      await expect(page.getByText("/workspace/project", { exact: true })).toBeVisible();
      if (en)
        await page
          .locator(".chat-container .native-requests")
          .screenshot({ path: test.info().outputPath("claude-folder-trust-mobile.png") });
      await page
        .getByRole("button", {
          name: en ? "Trust folder and continue" : "Ordner vertrauen und fortfahren",
          exact: true,
        })
        .click();
      await expect(input).toBeEnabled();
      await expect(input).toHaveValue("Keep my Claude message");
      expect(state.calls.filter((c) => c.path.endsWith("/answer")).at(-1).body).toEqual({
        expectedRevision: 1,
        choice: "trust",
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
    });
  });
}
