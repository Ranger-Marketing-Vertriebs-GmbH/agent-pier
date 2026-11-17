import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";
import { inboxFixture } from "./inbox-fixture.js";

// Claude Code 2.1.304 asks both during a running session; the server sends its own
// option labels, the browser shows them in the UI language by ID.
const defaultRequest = {
  id: "auto-default",
  sessionId: "fixture-session",
  revision: 1,
  status: "pending",
  source: "claude",
  kind: "permission",
  presentation: "claudeStartupPrompt",
  subject: { dialog: "autoModeDefault" },
  options: [
    { id: "accept", label: "Yes, set auto mode as my default permission mode" },
    { id: "decline", label: "No, keep manual mode" },
  ],
};
const billingRequest = {
  ...defaultRequest,
  id: "auto-billing",
  subject: { dialog: "autoModeBilling" },
  options: [
    { id: "continue", label: "Continue" },
    { id: "cancel", label: "Cancel" },
  ],
};
// Claude Code 2.1.326 asks at startup to trust the chat attachment folder (--add-dir).
const folder =
  "/Users/owner/Library/Application Support/AgentPier/chat-attachments/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000";
const folderRequest = {
  ...defaultRequest,
  id: "added-folder",
  subject: { dialog: "addedFolder", path: folder },
  options: [
    { id: "exit", label: "No, exit" },
    { id: "add", label: "Yes, add it" },
  ],
};
const text = {
  "en-GB": {
    message: "Message",
    defaultTitle: "Make auto mode the default?",
    keep: "Keep the current mode",
    accept: "Make auto mode the default",
    billingTitle: "Claude auto mode billing notice",
    continue: "Continue in auto mode",
    cancel: "Cancel the action",
    folderTitle: "Add the chat attachment folder",
    add: "Add folder and continue",
    exit: "Exit session",
  },
  "de-DE": {
    message: "Nachricht",
    defaultTitle: "Auto-Modus als Standard festlegen?",
    keep: "Aktuellen Modus behalten",
    accept: "Auto-Modus als Standard festlegen",
    billingTitle: "Abrechnungshinweis zum Claude-Auto-Modus",
    continue: "Im Auto-Modus fortfahren",
    cancel: "Aktion abbrechen",
    folderTitle: "Chat-Anhangsordner hinzufügen",
    add: "Ordner hinzufügen und fortfahren",
    exit: "Session beenden",
  },
};

for (const locale of ["de-DE", "en-GB"])
  for (const [viewport, width] of [
    ["desktop", 1280],
    ["mobile", 390],
  ])
    test.describe(`Claude auto mode dialogs ${locale} ${viewport}`, () => {
      test.use({ locale });
      test("each dialog holds chat messages and answers with one native choice", async ({
        page,
      }) => {
        const t = text[locale];
        await page.setViewportSize({ width, height: 844 });
        const state = await operationsFixture(page);
        await page.goto(baseURL + "/sessions/fixture-session/chat");
        const input = page.getByRole("textbox", { name: t.message, exact: true });
        await expect(input).toBeEnabled();
        await input.fill("Keep my Claude message");
        state.requests = [defaultRequest];
        await expect(page.getByText(t.defaultTitle, { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: t.accept })).toBeVisible();
        if (locale === "en-GB")
          await page
            .locator(".chat-container .native-requests")
            .screenshot({ path: test.info().outputPath(`auto-default-${viewport}.png`) });
        await page.getByRole("button", { name: t.keep, exact: true }).click();
        await expect(input).toHaveValue("Keep my Claude message");
        const answers = () => state.calls.filter((c) => c.path.endsWith("/answer"));
        expect(answers().at(-1).body).toEqual({ expectedRevision: 1, choice: "decline" });

        state.requests = [billingRequest];
        await expect(page.getByText(t.billingTitle, { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: t.cancel })).toBeVisible();
        await page.getByRole("button", { name: t.continue, exact: true }).click();
        await expect(input).toBeEnabled();
        await expect(input).toHaveValue("Keep my Claude message");
        expect(answers().at(-1).body).toEqual({
          expectedRevision: 1,
          choice: "continue",
        });

        state.requests = [folderRequest];
        await expect(page.getByText(t.folderTitle, { exact: true })).toBeVisible();
        await expect(page.getByText(folder, { exact: true })).toBeVisible();
        await expect(
          page.getByRole("button", { name: t.exit, exact: true }),
        ).toBeVisible();
        if (locale === "en-GB")
          await page
            .locator(".chat-container .native-requests")
            .screenshot({ path: test.info().outputPath(`added-folder-${viewport}.png`) });
        await page.getByRole("button", { name: t.add, exact: true }).click();
        await expect(input).toHaveValue("Keep my Claude message");
        expect(answers().at(-1).body).toEqual({ expectedRevision: 1, choice: "add" });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        ).toBe(true);
      });
    });

test("the inbox lists the billing notice as a question from Claude", async ({ page }) => {
  const state = await inboxFixture(page, { language: "en" });
  const createdAt = new Date().toISOString();
  const request = { ...billingRequest, sessionId: "beta", createdAt };
  state.items.push({
    type: "approval",
    tab: "approvals",
    id: request.id,
    kind: "claudeStartupPrompt",
    status: "pending",
    source: { kind: "session", id: "beta", name: "Session beta", tool: "claude" },
    title: "",
    createdAt,
    expiresAt: null,
    link: "/sessions/beta/chat",
  });
  await page.route("**/api/sessions/beta/requests", (route) =>
    route.fulfill({ json: { requests: [request] } }),
  );
  // The list beside the item shows the kind; a phone shows the item alone.
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.goto(baseURL + "/inbox/approval/auto-billing");
  await expect(page.getByText("Question from Claude").first()).toBeVisible();
  await expect(
    page.getByText("Claude auto mode billing notice", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue in auto mode", exact: true }),
  ).toBeVisible();
});
