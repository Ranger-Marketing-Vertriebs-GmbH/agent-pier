import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";
import { execAction, setup } from "./assistant-shell-fixture.js";

// The shell level "Automatic review": a model, not the owner, decides which commands
// run without asking. The picker, its warning, its own confirmation and the card of a
// command the review handed to the owner, in English.
const save = (page) => saveBar(page).getByRole("button", { name: "Save agent" });
const shell = (page) => page.locator("#agent-shell");
const header = (page) => page.locator(".assistant-header-name");
const reviewRadio = (page) =>
  shell(page).getByRole("radio", { name: /^Automatic review/ });
const hermesInfo = {
  id: "hermes",
  name: "Hermes Agent",
  capabilities: {
    approvals: {
      available: true,
      shellLevels: ["off", "approval", "every", "full"],
      allowlist: "exactCommands",
    },
  },
};

for (const [label, use] of [
  ["desktop", {}],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
]) {
  test.describe(label, () => {
    test.use(use);

    test("automatic review sits between approval and full access and names its risk", async ({
      page,
    }) => {
      const state = await setup(page);
      await page.goto(baseURL + settingsPath("capabilities"));
      await expect(shell(page).getByRole("radio")).toHaveCount(4);
      const names = await shell(page)
        .getByRole("radio")
        .evaluateAll((radios) => radios.map((radio) => radio.value));
      expect(names).toEqual(["off", "approval", "review", "full"]);
      await reviewRadio(page).check();
      await expect(shell(page)).toContainText(
        "A model reviews every command that is not always allowed.",
      );
      await expect(shell(page)).toContainText(
        "a model, not you, decides which commands run without asking",
      );
      await expect(shell(page)).toContainText("can read AgentPier's own data");
      await save(page).click();
      await page
        .getByRole("dialog", { name: "Turn on shell access?" })
        .getByRole("button", { name: "Turn on shell access" })
        .click();
      const review = page.getByRole("dialog", {
        name: "Let a model decide which commands run?",
      });
      await expect(review).toContainText("you no longer see every command first");
      await expect(review).toContainText("whenever the review fails");
      expect(state.patches.map((p) => [p.confirmShell, p.confirmReview])).toEqual([
        [undefined, undefined],
        [true, undefined],
      ]);
      await review.getByRole("button", { name: "Allow automatic review" }).click();
      await expect.poll(() => state.patches.length).toBe(3);
      expect(state.patches[2]).toMatchObject({
        shell: "review",
        confirmShell: true,
        confirmReview: true,
      });
      expect(state.patches[2].confirmFull).toBeUndefined();
      await expect(review).toHaveCount(0);
      await expect(header(page).getByText("Shell: reviewed")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    });

    test("cancelling the review's confirmation returns to the saved level", async ({
      page,
    }) => {
      const state = await setup(page, { agent: { shell: "approval" } });
      await page.goto(baseURL + settingsPath("capabilities"));
      await reviewRadio(page).check();
      await save(page).click();
      await page
        .getByRole("dialog", { name: "Turn on shell access?" })
        .getByRole("button", { name: "Turn on shell access" })
        .click();
      const review = page.getByRole("dialog", {
        name: "Let a model decide which commands run?",
      });
      await review.getByRole("button", { name: "Cancel" }).click();
      await expect(review).toHaveCount(0);
      await expect(
        shell(page).getByRole("radio", { name: /^With approval/ }),
      ).toBeChecked();
      expect(state.patches).toHaveLength(2);
      await expect(header(page).getByText("Shell: approval")).toBeVisible();
    });

    test("lowering from automatic review needs no confirmation", async ({ page }) => {
      const state = await setup(page, { agent: { shell: "review" } });
      await page.goto(baseURL + settingsPath("capabilities"));
      await expect(reviewRadio(page)).toBeChecked();
      await expect(header(page).getByText("Shell: reviewed")).toBeVisible();
      await shell(page)
        .getByRole("radio", { name: /^With approval/ })
        .check();
      await expect(shell(page)).not.toContainText("a model, not you, decides");
      await save(page).click();
      await expect.poll(() => state.patches.length).toBe(1);
      expect(state.patches[0]).toMatchObject({ shell: "approval" });
      expect(state.patches[0].confirmShell).toBeUndefined();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    test("a command the review handed over shows the reviewer's note", async ({
      page,
    }) => {
      const note =
        "Exec auto-review deferred to human approval (risk=high): pushes to the main branch";
      const state = await setup(page, {
        agent: { shell: "review" },
        actions: [
          execAction("reviewed", {
            allowAlwaysByAgentPier: false,
            allowAlwaysPlan: undefined,
            payload: {
              ...execAction("x").payload,
              command: "git push origin main",
              warningText: note,
            },
          }),
        ],
      });
      await page.goto(baseURL + "/agents/home/chats/chat");
      const card = page.getByRole("article", { name: "Shell command awaiting approval" });
      await expect(card).toContainText("git push origin main");
      await expect(card).toContainText(`OpenClaw notes: ${note}`);
      await card.getByRole("button", { name: "Deny" }).click();
      await expect
        .poll(() => state.decisions)
        .toEqual([["reviewed", { revision: 1, decision: "deny" }]]);
    });

    test("a runtime without the review says why the level is missing", async ({
      page,
    }) => {
      await setup(page, { agent: { runtime: "hermes", runtimeInfo: hermesInfo } });
      await page.goto(baseURL + settingsPath("capabilities"));
      await expect(
        shell(page).getByRole("radio", { name: /^Every command/ }),
      ).toBeVisible();
      await expect(reviewRadio(page)).toHaveCount(0);
      await expect(shell(page)).toContainText(
        "Automatic review is not available on Hermes Agent",
      );
    });
  });
}
