import { test, expect } from "../helpers/browser-test.js";
import { operationsFixture } from "./operations-fixture.js";
import { baseURL } from "../helpers/browser.js";
import { openNewSession } from "../helpers/navigation.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { isLiveStubRequest } from "../helpers/live-stub.js";
// The chat follows the pushed `session.requests` topic: a stalled REST read of the
// requests (the page's own) never stands between the startup hook trust and the chat.
for (const width of [1440, 390])
  test(`a stalled first approval read cannot hide startup hook trust at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem("agentpier-language", "en");
      sessionStorage.setItem(
        "agentpier.session-views.v1",
        JSON.stringify({ preferred: "reader", entries: [] }),
      );
    });
    const state = await operationsFixture(page);
    const chat = {
      messages: [],
      tasks: [],
      availability: "unbound",
      manualBindingSupported: false,
    };
    await mockChatStream(page, () => chat);
    await page.route("**/api/sessions/fixture-session/chat", (route) =>
      route.fulfill({ json: chat }),
    );
    await page.route("**/api/sessions", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      state.requests = [
        {
          id: "hooks",
          sessionId: "fixture-session",
          revision: 1,
          status: "pending",
          source: "codex",
          kind: "permission",
          presentation: "codexHookTrust",
          hookCount: 7,
          subject: {
            command: Array(7)
              .fill("SessionStart\necho fixture\nfixture-key")
              .join("\n\n"),
            cwd: "/fixture",
          },
          options: [
            { id: "trust", label: "Trust all and continue", scope: "persistent" },
            { id: "skip", label: "Continue without trusting" },
          ],
        },
      ];
      return route.fulfill({
        status: 201,
        json: {
          ...route.request().postDataJSON(),
          id: "fixture-session",
          status: "running",
          nativeRequests: { enabled: true, version: 1 },
        },
      });
    });
    let release;
    const stalled = new Promise((resolve) => {
      release = resolve;
    });
    // Every REST read the page itself makes stalls; the live stub's reads answer.
    let pageReads = 0;
    await page.route("**/api/sessions/fixture-session/requests", async (route) => {
      if (isLiveStubRequest(route.request())) return route.fallback();
      pageReads += 1;
      await stalled;
      await route.fulfill({ json: { requests: [] } }).catch(() => {});
    });
    await page.goto(baseURL);
    await openNewSession(page);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    await expect(page).toHaveURL(/sessions\/fixture-session\/chat$/);
    try {
      await expect(page.getByText("Review Codex hooks", { exact: true })).toBeInViewport({
        timeout: 10000,
      });
    } finally {
      release();
    }
    expect(pageReads).toBe(0);
    await expect(
      page.getByRole("button", { name: "Trust hooks and continue", exact: true }),
    ).toBeEnabled();
    await expect(page.getByText("Review Codex hooks", { exact: true })).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath("startup.png") });
    expect(state.calls.some((call) => call.path.endsWith("/answer"))).toBe(false);
    await page
      .getByRole("button", { name: "Trust hooks and continue", exact: true })
      .click();
    await expect(page.getByText("Review Codex hooks", { exact: true })).toHaveCount(0);
    expect(state.calls.filter((call) => call.path.endsWith("/answer"))).toMatchObject([
      { body: { choice: "trust", expectedRevision: 1 } },
    ]);
  });
