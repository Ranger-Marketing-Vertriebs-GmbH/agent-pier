import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { setupAssistantSettings } from "../helpers/assistant-settings-browser.js";
import { settingsPath } from "../helpers/agent-settings-page.js";
import { setup } from "./assistant-shell-fixture.js";
import {
  catalog,
  openChat,
  opnsense,
  sshAction,
  sshCard,
} from "./assistant-ssh-fixture.js";

const fits = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const longLine = `curl -sS https://example.invalid/${"x".repeat(400)}`;

for (const [label, viewport] of [
  ["phone", { width: 375, height: 812 }],
  ["desktop", { width: 1280, height: 800 }],
])
  for (const language of ["en", "de"])
    test.describe(`${label} ${language}`, () => {
      test.use({ viewport });

      test("the SSH page and the card never scroll sideways", async ({ page }) => {
        await setupAssistantSettings(page, {
          language,
          catalog: catalog(),
          access: {
            revision: 0,
            sshAccesses: [{ accessId: opnsense.id, mode: "trusted" }],
          },
        });
        await page.goto(baseURL + settingsPath("work", "ssh"));
        await expect(
          page.getByRole("group", { name: language === "de" ? "Modus" : "Mode" }),
        ).toBeVisible();
        expect(await fits(page)).toBe(true);
        for (const radio of await page.getByRole("radio").all()) {
          const box = await radio.locator("xpath=ancestor::label").boundingBox();
          expect(box.height).toBeGreaterThanOrEqual(44);
        }
        await setup(page, {
          actions: [sshAction("a1", { payload: { command: longLine } })],
        });
        await page.addInitScript(
          (l) => localStorage.setItem("agentpier-language", l),
          language,
        );
        await openChat(page);
        await expect(sshCard(page, language)).toBeVisible();
        expect(await fits(page)).toBe(true);
      });
    });

test("German copy appears on the card and the Work row", async ({ page }) => {
  await setup(page, { actions: [sshAction("a1")] });
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "de"));
  await openChat(page);
  await expect(
    page.getByRole("button", { name: "Einmal erlauben auf opnsense" }),
  ).toBeVisible();
  await setupAssistantSettings(page, { language: "de", catalog: catalog() });
  await page.goto(baseURL + settingsPath("work"));
  await expect(page.getByRole("link", { name: /^SSH-Zugänge/ })).toContainText("Keine");
});

test("the card and the modes work with the keyboard alone", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "keyboard operation is a desktop behaviour");
  const state = await setup(page, { actions: [sshAction("a1")] });
  await openChat(page);
  const allow = sshCard(page).getByRole("button", { name: "Allow once on opnsense" });
  await allow.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => state.decisions.length).toBe(1);
  await setupAssistantSettings(page, {
    catalog: catalog(),
    access: { revision: 0, sshAccesses: [{ accessId: opnsense.id, mode: "approval" }] },
  });
  await page.goto(baseURL + settingsPath("work", "ssh"));
  const approval = page.getByRole("radio", { name: /^With approval/ });
  await approval.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("radio", { name: /^Trusted Runs/ })).toBeChecked();
});

test("a routine's result says when SSH was refused", async ({ page }) => {
  await setup(page);
  await page.route(/\/messages(\?|$)/, (route) =>
    route.fulfill({
      json: {
        messages: [
          {
            id: "r1",
            role: "assistant",
            text: "Nightly check done.",
            timestamp: 1760608800000,
            runId: null,
            scheduled: { name: "Nightly", notes: ["ssh_refused"] },
          },
        ],
        requests: [],
        stale: false,
      },
    }),
  );
  await openChat(page);
  await expect(
    page.getByText("SSH refused: host not trusted for routines"),
  ).toBeVisible();
});
