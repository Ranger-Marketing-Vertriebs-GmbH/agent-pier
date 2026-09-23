import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";

const question = {
  id: "request-one",
  sessionId: "fixture-session",
  revision: 1,
  status: "pending",
  source: "codex",
  kind: "question",
  createdAt: "2026-09-07T12:00:00Z",
  questions: [
    {
      id: "q0",
      prompt: "Choose a target",
      options: [{ id: "local", label: "Local" }],
      multiple: false,
      allowOther: false,
    },
  ],
};

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(`chat while a question is open ${locale}`, () => {
    test.use({ locale, viewport: { width: 390, height: 844 } });
    test("a message sent during an open question waits and follows the answer", async ({
      page,
    }) => {
      const en = locale === "en-GB";
      const state = await operationsFixture(page);
      state.requests = [question];
      await page.goto(baseURL + "/sessions/fixture-session/chat");
      await expect(page.getByText("Choose a target", { exact: true })).toBeVisible();
      const input = page.getByRole("textbox", {
        name: en ? "Message" : "Nachricht",
        exact: true,
      });
      await expect(input).toBeEnabled();
      await input.fill("Also update the changelog");
      await page
        .getByRole("button", { name: en ? "Send" : "Senden", exact: true })
        .click();
      await expect(
        page.getByText(
          en
            ? /Waiting for the open request to be answered/
            : /Wartet auf die Antwort zur offenen Anfrage/,
        ),
      ).toBeVisible();
      // Held by the server, never refused and never retyped.
      expect(state.inputs).toHaveLength(1);
      if (en)
        await page
          .locator(".chat-compose-area")
          .screenshot({ path: test.info().outputPath("chat-request-queue-mobile.png") });
      await page.getByLabel("Local", { exact: true }).check();
      await page
        .getByRole("button", { name: en ? "Send answer" : "Antwort senden", exact: true })
        .click();
      await expect(
        page.getByText(
          en
            ? "Sent to TUI · awaiting CLI confirmation"
            : "An TUI gesendet · CLI-Bestätigung steht aus",
          { exact: true },
        ),
      ).toBeVisible({ timeout: 10000 });
      expect(state.inputs).toHaveLength(1);
      await expect(input).toHaveValue("");
    });
  });
}
