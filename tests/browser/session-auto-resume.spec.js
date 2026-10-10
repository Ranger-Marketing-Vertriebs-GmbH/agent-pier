import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(`automatic session resume ${locale}`, () => {
    test.use({ locale });
    test("the setting saves a boolean and a failed resume explains why", async ({
      page,
    }) => {
      const en = locale === "en-GB";
      const state = await operationsFixture(page);
      await page.goto(baseURL + "/settings");
      const toggle = page.getByRole("switch", {
        name: en
          ? "Resume interrupted sessions automatically"
          : "Unterbrochene Sitzungen automatisch fortsetzen",
      });
      await expect(toggle).toBeChecked();
      await toggle.click();
      await expect
        .poll(
          () =>
            state.calls.find((c) => c.method === "PATCH" && c.path === "/preferences")
              ?.body,
        )
        .toEqual({ autoResumeInterrupted: false });
      await page.route("**/api/state", (route) =>
        route.fulfill({
          json: {
            tools: [{ id: "codex", name: "codex", installed: true }],
            accounts: [
              { id: "local-codex", tool: "codex", kind: "local", name: "Codex lokal" },
            ],
            sessions: [
              {
                id: "fixture-session",
                name: "Fixture session",
                tool: "codex",
                accountId: "local-codex",
                status: "stopped",
                cwd: "/fixture",
                interruption: {
                  cause: "tmux-server-lost",
                  at: "2026-10-10T10:00:00.000Z",
                  resume: "failed",
                  reason: "reload-failed",
                },
              },
            ],
            home: "/fixture",
            defaultCwd: "/fixture",
            autoResumeInterrupted: false,
          },
        }),
      );
      await page.route("**/api/sessions/fixture-session/screen", (route) =>
        route.fulfill({ json: { text: "" } }),
      );
      await page.goto(baseURL + "/sessions/fixture-session");
      await expect(
        page.getByText(
          en
            ? "This session was interrupted and could not be resumed automatically: the reload failed."
            : "Diese Sitzung wurde unterbrochen und konnte nicht automatisch fortgesetzt werden: Das Neuladen ist fehlgeschlagen.",
        ),
      ).toBeVisible();
    });
  });
}
