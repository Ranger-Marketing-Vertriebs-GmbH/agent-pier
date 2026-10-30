import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";
import { isLiveStubRequest } from "../helpers/live-stub.js";
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
  // The composer stays usable: a message sent now waits for the answer.
  await expect(
    page.getByRole("textbox", { name: "Nachricht", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Modell auswählen", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Nächste Frage", exact: true }).click();
  expect(state.calls.some((call) => call.path.endsWith("/answer"))).toBe(false);
  await page.getByLabel("Tests", { exact: true }).check();
  await page.getByLabel("Docs", { exact: true }).check();
  await page.getByRole("button", { name: "Nächste Frage", exact: true }).click();
  await page.getByLabel("Local", { exact: true }).check();
  state.fail = "/sessions/fixture-session/requests/request-one/answer";
  await page.getByRole("button", { name: "Antwort senden", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Fixture conflict");
  await page.getByRole("button", { name: "Vorherige Frage", exact: true }).click();
  await expect(page.getByLabel("Tests", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Nächste Frage", exact: true }).click();
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
test("a permission card offers remembering the program for the session or project", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  const remember = { tool: "Bash", programs: ["rm", "git push"] };
  state.requests = [
    {
      ...request,
      kind: "permission",
      source: "claude",
      questions: undefined,
      subject: { tool: "Bash", command: "rm -rf build && git push" },
      options: [
        { id: "allow", label: "Einmal erlauben", scope: "once" },
        { id: "remember-session", label: "x", scope: "session", remember },
        { id: "remember-project", label: "x", scope: "project", remember },
        { id: "deny", label: "Ablehnen" },
      ],
    },
  ];
  await page.goto(baseURL + "/sessions/fixture-session/chat");
  await expect(
    page.getByRole("button", { name: "rm, git push in dieser Session immer erlauben" }),
  ).toBeVisible();
  await expect(page.getByText("Dieses Projekt", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "rm, git push in diesem Projekt immer erlauben" })
    .click();
  expect(state.calls.find((call) => call.path.endsWith("/answer")).body).toEqual({
    expectedRevision: 1,
    choice: "remember-project",
  });
});
test.describe("English remembered approvals", () => {
  test.use({ locale: "en-GB" });
  test("the remember options read in English", async ({ page }) => {
    const state = await operationsFixture(page);
    state.requests = [
      {
        ...request,
        kind: "permission",
        source: "claude",
        questions: undefined,
        subject: { tool: "WebFetch" },
        options: [
          { id: "allow", label: "Allow once", scope: "once" },
          {
            id: "remember-session",
            label: "x",
            scope: "session",
            remember: { tool: "WebFetch" },
          },
          { id: "deny", label: "Deny" },
        ],
      },
    ];
    await page.goto(baseURL + "/sessions/fixture-session/chat");
    await expect(
      page.getByRole("button", { name: "Always allow WebFetch in this session" }),
    ).toBeVisible();
  });
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
  const language = viewport.width === 390 ? "en" : "de";
  test(`native question forms stay in Chat at ${viewport.width}px (${language})`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript((value) => {
      localStorage.setItem("agentpier-language", value);
    }, language);
    await page.setViewportSize(viewport);
    const state = await operationsFixture(page);
    const inputs = [];
    await page.routeWebSocket("**/api/sessions/*/terminal", (socket) => {
      socket.onMessage((message) => {
        const data = JSON.parse(message);
        if (data.type === "input") inputs.push(data.data);
      });
      socket.send(
        JSON.stringify({
          type: "output",
          data: "Choose a scope\r\n1. Tests\r\n2. Docs\r\nNative terminal ready\r\n",
        }),
      );
    });
    state.requests = [{ ...request, source: "claude" }];
    await page.goto(baseURL + "/sessions/fixture-session/terminal");
    await expect(page.locator(".terminal-mount .xterm")).toBeVisible();
    await expect(page.locator(".xterm-rows")).toContainText("Native terminal ready");
    await expect(page.locator(".native-requests")).toBeHidden();
    await expect(page.locator(".chat-container")).toBeHidden();
    const fullTerminal = await page.locator(".terminal-mount").boundingBox();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    const panel = page.locator(".chat-container .native-requests");
    await expect(panel.getByText("Choose a scope", { exact: true })).toBeVisible();
    await expect(page.locator(".terminal-mount")).toBeHidden();
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await expect(page.locator(".xterm-rows")).toContainText("Choose a scope");
    await expect(page.locator(".native-requests")).toBeHidden();
    await expect(page.locator(".chat-container")).toBeHidden();
    const terminal = await page.locator(".terminal-mount").boundingBox();
    expect(terminal.height).toBe(fullTerminal.height);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(viewport.width);
    await page.locator(".xterm-helper-textarea").press("1");
    await page.locator(".xterm-helper-textarea").press("Enter");
    await expect.poll(() => inputs.join("")).toBe("1\r");
    expect(state.calls.some((call) => call.path.endsWith("/answer"))).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("terminal-question.png") });
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(panel.getByText("Choose a scope", { exact: true })).toBeVisible();
    await panel.getByLabel("Tests", { exact: true }).check();
    await panel
      .getByRole("button", {
        name: language === "en" ? "Next question" : "Nächste Frage",
        exact: true,
      })
      .click();
    await panel.getByLabel("Local", { exact: true }).check();
    await panel.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: testInfo.outputPath("chat-question.png") });
    await panel
      .getByRole("button", {
        name: language === "en" ? "Send answer" : "Antwort senden",
        exact: true,
      })
      .click();
    await expect(panel).toHaveCount(0);
    expect(state.calls.find((call) => call.path.endsWith("/answer")).body).toEqual({
      expectedRevision: 1,
      answers: { "question-one": ["tests"], "question-two": ["local"] },
    });
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
      await expect(input).toBeEnabled();
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
      await expect(input).toBeEnabled();
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

// Every view of one session's requests shares one live topic (AGENTPIER-266): two
// escalation cards of the same session subscribe `session.requests` once, so the
// stub reads /requests once per 1.5 s for both (two subscriptions would put reads
// close together), and the page itself reads nothing.
test("escalation cards of one session share one requests topic", async ({ page }) => {
  const escalation = (id, promptId) => ({
    id,
    assistantId: "home",
    revision: 1,
    state: "awaiting_approval",
    createdAt: "2026-10-27T08:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    payload: {
      action: "session_request",
      sessionId: "agent-session",
      promptId,
      sessionName: "Codex · demo",
      kind: "permission",
      title: "shell",
    },
  });
  const prompt = (id) => ({
    id,
    sessionId: "agent-session",
    kind: "permission",
    source: "codex",
    status: "pending",
    revision: 1,
    options: [{ id: "allow", label: "Allow" }],
    subject: { tool: "shell", description: `Prompt ${id}` },
  });
  await chatFixture(page, {
    actions: [escalation("escalation-1", "p1"), escalation("escalation-2", "p2")],
  });
  await page.route(/\/api\/sessions\/agent-session\/requests$/, (route) =>
    route.fulfill({ json: { requests: [prompt("p1"), prompt("p2")] } }),
  );
  const reads = [];
  const pageReads = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      url.pathname === "/api/sessions/agent-session/requests"
    )
      (isLiveStubRequest(request) ? reads : pageReads).push(Date.now());
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  const cards = page.locator("[data-session-escalation]");
  await expect(cards).toHaveCount(2);
  await expect(cards.getByRole("button", { name: "Allow" })).toHaveCount(2);
  reads.length = 0;
  await page.waitForTimeout(6000);
  expect(pageReads).toEqual([]);
  expect(reads.length).toBeGreaterThanOrEqual(2);
  const gaps = reads.slice(1).map((at, index) => at - reads[index]);
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1400);
});
