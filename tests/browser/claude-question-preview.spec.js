import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";
import { claudeRequest } from "../../server/features/requests/claude-hook.js";

const markup = '<b id="injected">bold</b><img src=x onerror="window.pwned=1">';
const mockup =
  "+--------+--------+--------+--------+--------+--------+\n| a      | b      | c      | d      | e      | f      |";
const adapter = claudeRequest({
  hook_event_name: "PreToolUse",
  tool_name: "AskUserQuestion",
  tool_input: {
    questions: [
      {
        header: "Layout",
        question: "Which layout?\nPick the one that fits.",
        options: [
          { label: "Grid", description: "Cards", preview: mockup },
          { label: "Markup", description: "Rich", preview: markup },
        ],
      },
      {
        header: "Parts",
        question: "Which parts?",
        options: [
          { label: "API", description: "Service" },
          { label: "Web", description: "UI" },
        ],
        multiSelect: true,
      },
    ],
  },
});
const pending = {
  ...adapter.view,
  id: "claude-preview",
  sessionId: "fixture-session",
  revision: 1,
  status: "pending",
  source: "claude",
};
const calls = (state, suffix) => state.calls.filter((call) => call.path.endsWith(suffix));
const copy = (en) => ({
  next: en ? "Next question" : "Nächste Frage",
  send: en ? "Send answer" : "Antwort senden",
  decline: en ? "Decline" : "Ablehnen",
  note: en ? "Note for Claude (optional)" : "Notiz für Claude (optional)",
  preview: en ? "Preview: " : "Vorschau: ",
  other: en ? "Other answer" : "Andere Antwort",
  handoff: en ? "Answer in terminal" : "Im Terminal beantworten",
});

for (const locale of ["de-DE", "en-GB"]) {
  const en = locale === "en-GB";
  const text = copy(en);
  test.describe(`Claude question previews ${locale}`, () => {
    test.use({ locale });
    for (const width of [390, 1280]) {
      test(`previews are plain text and answers carry notes at ${width}px`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width, height: width === 390 ? 700 : 900 });
        const state = await operationsFixture(page, { tool: "claude" });
        state.requests = [pending];
        await page.goto(baseURL + "/sessions/fixture-session/chat");
        const legend = page.locator(".native-question legend");
        await expect(legend).toContainText("Which layout?\nPick the one that fits.");
        await expect(legend).toHaveCSS("white-space", "pre-wrap");
        await expect(legend).toHaveAttribute("dir", "auto");
        const preview = page.getByLabel(text.preview + "Grid", { exact: true });
        await expect(preview).toHaveText(mockup);
        await expect(preview).toHaveCSS("white-space", "pre");
        // The wide mockup scrolls inside its box; the page never scrolls sideways.
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        await page.getByLabel("Markup", { exact: true }).check();
        const html = page.getByLabel(text.preview + "Markup", { exact: true });
        await expect(html).toHaveText(markup);
        await expect(page.locator("#injected")).toHaveCount(0);
        expect(await page.evaluate(() => window.pwned)).toBeUndefined();
        await page.getByLabel("Grid", { exact: true }).check();
        await page.getByText(text.note, { exact: true }).click();
        await page
          .getByRole("textbox", { name: new RegExp(`Which layout`) })
          .fill("  Keep it compact ");
        await page.getByRole("button", { name: text.next, exact: true }).click();
        await page.getByLabel("API", { exact: true }).check();
        await page.getByLabel(text.other, { exact: true }).check();
        const other = page.getByRole("textbox", {
          name: `${text.other}: Which parts?`,
          exact: true,
        });
        await expect(other).toHaveAttribute("dir", "auto");
        // Repeating a selected label must not fail the whole answer.
        await other.fill("API");
        await expect.poll(() => calls(state, "/touch").length).toBeGreaterThan(0);
        expect(calls(state, "/touch")[0].body.client).toMatch(/^[A-Za-z0-9_-]+$/);
        if (width === 390 && en)
          await page.screenshot({ path: testInfo.outputPath("question-mobile.png") });
        await page.getByRole("button", { name: text.send, exact: true }).click();
        await expect.poll(() => calls(state, "/answer").length).toBe(1);
        const body = calls(state, "/answer")[0].body;
        expect(body).toEqual({
          expectedRevision: 1,
          answers: { q0: ["Grid"], q1: ["API"] },
          notes: { q0: "Keep it compact" },
        });
        const input = adapter.answer(body).hookSpecificOutput.updatedInput;
        expect(input.annotations).toEqual({
          "Which layout?\nPick the one that fits.": {
            preview: mockup,
            notes: "Keep it compact",
          },
        });
      });
    }

    test("declining sends a denial with notes and no answers", async ({ page }) => {
      const state = await operationsFixture(page, { tool: "claude" });
      state.requests = [pending];
      await page.goto(baseURL + "/sessions/fixture-session/chat");
      await page.getByText(text.note, { exact: true }).click();
      await page.getByRole("textbox", { name: /Which layout/ }).fill("Not today");
      await page.getByRole("button", { name: text.decline, exact: true }).click();
      await expect.poll(() => calls(state, "/answer").length).toBe(1);
      expect(calls(state, "/answer")[0].body).toEqual({
        expectedRevision: 1,
        decline: true,
        notes: { q0: "Not today" },
      });
    });

    test("Codex questions offer neither decline nor notes", async ({ page }) => {
      const state = await operationsFixture(page, { tool: "codex" });
      state.requests = [
        {
          kind: "question",
          id: "codex-question",
          sessionId: "fixture-session",
          revision: 1,
          status: "pending",
          source: "codex",
          questions: [
            {
              id: "q0",
              prompt: "Which?",
              multiple: false,
              allowOther: false,
              options: [{ id: "A", label: "A" }],
            },
          ],
        },
      ];
      await page.goto(baseURL + "/sessions/fixture-session/chat");
      await expect(page.getByLabel("A", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: text.decline })).toHaveCount(0);
      await expect(page.getByText(text.note, { exact: true })).toHaveCount(0);
    });

    test("an uncertain delivery keeps the terminal handoff reachable", async ({
      page,
    }) => {
      const state = await operationsFixture(page, { tool: "claude" });
      state.requests = [{ ...pending, status: "unknown", revision: 2 }];
      await page.goto(baseURL + "/sessions/fixture-session/chat");
      await expect(
        page.getByText(
          en
            ? "Delivery uncertain. Check the terminal."
            : "Zustellung unklar. Im Terminal prüfen.",
        ),
      ).toBeVisible();
      await page.getByRole("button", { name: text.handoff, exact: true }).click();
      await expect.poll(() => calls(state, "/handoff").length).toBe(1);
      expect(calls(state, "/handoff")[0].body).toEqual({ expectedRevision: 2 });
      expect(calls(state, "/answer")).toHaveLength(0);
    });
  });
}
