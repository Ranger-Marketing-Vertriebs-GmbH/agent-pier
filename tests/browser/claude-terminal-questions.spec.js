import { test, expect } from "@playwright/test";
import { operationsFixture } from "./operations-fixture.js";

const question = {
  id: "terminal-question",
  sessionId: "fixture-session",
  kind: "question",
  source: "claude",
  revision: 1,
  status: "pending",
  questions: [
    {
      id: "q0",
      prompt: "Which destination?",
      options: [{ id: "Local", label: "Local" }],
    },
  ],
};
const handoffs = (state) => state.calls.filter((call) => call.path.endsWith("/handoff"));

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(`Claude native terminal questions ${locale}`, () => {
    test.use({ locale, viewport: { width: 390, height: 600 } });

    test("terminal releases pending and subsequent questions without answering them", async ({
      page,
    }) => {
      const state = await operationsFixture(page, { tool: "claude" });
      state.requests = [question];
      await page.goto("/sessions/fixture-session/terminal");
      await expect.poll(() => handoffs(state).length).toBe(1);
      expect(handoffs(state)[0].body).toEqual({ expectedRevision: 1 });
      await expect(page.locator(".native-requests:visible")).toHaveCount(0);
      // Claude may invoke PermissionRequest after releasing PreToolUse.
      state.requests = [{ ...question, id: "fallback-question", revision: 2 }];
      await expect.poll(() => handoffs(state).length).toBe(2);
      expect(handoffs(state)[1].body).toEqual({ expectedRevision: 2 });
      expect(state.calls.filter((call) => call.path.endsWith("/answer"))).toHaveLength(0);
    });

    test("chat retains HTML questions until the user switches to terminal", async ({
      page,
    }) => {
      const state = await operationsFixture(page, { tool: "claude" });
      state.requests = [question];
      await page.goto("/sessions/fixture-session/chat");
      await expect(page.getByRole("radio", { name: "Local", exact: true })).toBeVisible();
      expect(handoffs(state)).toHaveLength(0);
      await page
        .locator(".terminal-topbar")
        .getByRole("button", { name: "Terminal", exact: true })
        .click();
      await expect.poll(() => handoffs(state).length).toBe(1);
      await page
        .locator(".terminal-topbar")
        .getByRole("button", { name: "Chat", exact: true })
        .click();
      state.requests = [{ ...question, id: "next-chat-question" }];
      await expect(page.getByRole("radio", { name: "Local", exact: true })).toBeVisible();
      await page.getByRole("radio", { name: "Local", exact: true }).check();
      await page
        .getByRole("button", {
          name: locale === "de-DE" ? "Antwort senden" : "Send answer",
          exact: true,
        })
        .click();
      await expect
        .poll(() => state.calls.filter((call) => call.path.endsWith("/answer")).length)
        .toBe(1);
      expect(handoffs(state)).toHaveLength(1);
    });

    test("handoff failure is visible and does not approve a question", async ({
      page,
    }) => {
      const state = await operationsFixture(page, { tool: "claude" });
      state.requests = [question];
      state.fail = "/sessions/fixture-session/requests/terminal-question/handoff";
      await page.goto("/sessions/fixture-session/terminal");
      await expect(page.locator(".terminal-pane").getByRole("alert")).toContainText(
        "Fixture conflict",
      );
      expect(state.calls.filter((call) => call.path.endsWith("/answer"))).toHaveLength(0);
      state.fail = "";
      await expect.poll(() => state.requests.length).toBe(0);
      await expect(page.locator(".terminal-pane").getByRole("alert")).toHaveCount(0);
    });

    test("uncertain questions are released once and ordinary permissions never", async ({
      page,
    }) => {
      const state = await operationsFixture(page, { tool: "claude" });
      state.requests = [
        { ...question, status: "unknown", revision: 2 },
        { ...question, id: "permission", kind: "permission", subject: { tool: "Bash" } },
      ];
      state.fail = "/sessions/fixture-session/requests/terminal-question/handoff";
      await page.goto("/sessions/fixture-session/terminal");
      await expect.poll(() => handoffs(state).length).toBe(1);
      expect(handoffs(state)[0]).toMatchObject({
        path: "/sessions/fixture-session/requests/terminal-question/handoff",
        body: { expectedRevision: 2 },
      });
      await expect
        .poll(() => state.calls.filter((call) => call.path.endsWith("/requests")).length)
        .toBeGreaterThan(3);
      // A failed release of an uncertain delivery is not retried in a loop.
      expect(handoffs(state)).toHaveLength(1);
      expect(state.calls.filter((call) => call.path.endsWith("/answer"))).toHaveLength(0);
    });

    test("an unfocused terminal tab leaves questions to the focused device", async ({
      page,
    }) => {
      await page.addInitScript(() => {
        window.terminalFocused = false;
        document.hasFocus = () => window.terminalFocused;
      });
      const state = await operationsFixture(page, { tool: "claude" });
      state.requests = [question];
      await page.goto("/sessions/fixture-session/terminal");
      await expect(page.locator(".terminal-mount .xterm")).toBeVisible();
      await page.waitForTimeout(2000);
      expect(handoffs(state)).toHaveLength(0);
      await page.evaluate(() => {
        window.terminalFocused = true;
        window.dispatchEvent(new Event("focus"));
      });
      await expect.poll(() => handoffs(state).length).toBe(1);
    });

    test("a question in use on another device is not taken over", async ({ page }) => {
      const state = await operationsFixture(page, { tool: "claude" });
      state.requests = [{ ...question, interaction: { client: "phone", age: 500 } }];
      await page.goto("/sessions/fixture-session/terminal");
      await expect
        .poll(() => state.calls.filter((call) => call.path.endsWith("/requests")).length)
        .toBeGreaterThan(2);
      expect(handoffs(state)).toHaveLength(0);
      state.requests = [{ ...question, interaction: { client: "phone", age: 45000 } }];
      await expect.poll(() => handoffs(state).length).toBe(1);
    });

    test("a hidden terminal does not take questions away from chat on another device", async ({
      page,
    }) => {
      await page.addInitScript(() => {
        window.terminalVisible = false;
        Object.defineProperty(document, "visibilityState", {
          get: () => (window.terminalVisible ? "visible" : "hidden"),
          configurable: true,
        });
      });
      const state = await operationsFixture(page, { tool: "claude" });
      state.requests = [question];
      await page.goto("/sessions/fixture-session/terminal");
      await expect(page.locator(".terminal-mount .xterm")).toBeVisible();
      expect(handoffs(state)).toHaveLength(0);
      await page.evaluate(() => {
        window.terminalVisible = true;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await expect.poll(() => handoffs(state).length).toBe(1);
    });

    test("a pending terminal read cannot hand off after switching back to chat", async ({
      page,
    }) => {
      const state = await operationsFixture(page, { tool: "claude" });
      state.requests = [question];
      state.hold = "/sessions/fixture-session/requests";
      await page.goto("/sessions/fixture-session/terminal");
      await expect.poll(() => typeof state.release).toBe("function");
      const release = state.release;
      state.hold = "";
      await page
        .locator(".terminal-topbar")
        .getByRole("button", { name: "Chat", exact: true })
        .click();
      release();
      await expect(page.getByRole("radio", { name: "Local", exact: true })).toBeVisible();
      await page.getByRole("radio", { name: "Local", exact: true }).check();
      await page
        .getByRole("button", {
          name: locale === "de-DE" ? "Antwort senden" : "Send answer",
          exact: true,
        })
        .click();
      await expect
        .poll(() => state.calls.filter((call) => call.path.endsWith("/answer")).length)
        .toBe(1);
      expect(handoffs(state)).toHaveLength(0);
    });
  });
}
