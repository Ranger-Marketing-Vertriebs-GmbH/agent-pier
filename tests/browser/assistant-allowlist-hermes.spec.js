import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { settingsPath } from "../helpers/agent-settings-page.js";
import { setup } from "./assistant-shell-fixture.js";

// The always allowed commands of a Hermes agent: Hermes keeps no allowlist AgentPier
// writes, so the page lists the exact commands AgentPier remembers (`exactOnly`),
// says so, deletes them like OpenClaw's entries and follows the live topic.
const hermes = {
  runtime: "hermes",
  runtimeInfo: {
    id: "hermes",
    name: "Hermes Agent",
    version: "0.22.5",
    capabilities: { approvals: { available: true } },
  },
  shell: "approval",
};
const remembered = (id, command, addedAt) => ({
  id,
  pattern: "",
  source: "agentpier",
  kind: "command",
  command,
  cwd: "/agents/home/work",
  requestedAt: addedAt,
  addedAt,
});
const topic = "agent.allowlist:home";
const allowlist = (page) => page.locator("#agent-allowlist");

for (const [label, use] of [
  ["desktop", {}],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
]) {
  test.describe(label, () => {
    test.use(use);

    test("a Hermes agent lists, deletes and follows its remembered commands", async ({
      page,
      liveStub,
    }) => {
      const state = await setup(page, {
        agent: hermes,
        exactOnly: true,
        entries: [
          remembered(
            "cmd-0123456789abcdef0123456789abcdef",
            "python3 scripts/report.py --week",
            "2026-11-07T09:30:00.000Z",
          ),
          remembered(
            "cmd-fedcba9876543210fedcba9876543210",
            "node build.js",
            "2026-11-08T08:15:00.000Z",
          ),
        ],
      });
      await page.goto(baseURL + settingsPath("capabilities", "allowlist"));
      const list = allowlist(page).locator(".assistant-shell-entry");
      await expect(list).toHaveCount(2);
      await expect(allowlist(page)).toContainText(
        "On Hermes Agent, AgentPier remembers each always allowed command exactly",
      );
      await expect(list.nth(0)).toContainText("Exact command");
      await expect(list.nth(0)).toContainText("Added by AgentPier");
      await expect(list.nth(0)).toContainText("python3 scripts/report.py --week");
      await expect(list.nth(0)).toContainText(/Added \d/);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);

      // A new "Always allow" in a chat reaches the open page as a push.
      state.entries = [
        ...state.entries,
        remembered(
          "cmd-00000000000000000000000000000001",
          "bash -c 'make test'",
          "2026-11-08T10:00:00.000Z",
        ),
      ];
      await liveStub.reread(topic);
      await expect(list).toHaveCount(3);
      await expect(list.nth(2)).toContainText("bash -c 'make test'");

      await allowlist(page)
        .getByRole("button", { name: "Remove entry node build.js" })
        .click();
      await page
        .getByRole("dialog", { name: "Remove the entry node build.js?" })
        .getByRole("button", { name: "Remove now" })
        .click();
      await expect(list).toHaveCount(2);
      await expect(allowlist(page)).not.toContainText("node build.js");
      expect(state.deletes).toEqual(["cmd-fedcba9876543210fedcba9876543210"]);
    });

    test("an OpenClaw agent shows no exact-command note", async ({ page }) => {
      await setup(page, {
        agent: { shell: "approval" },
        entries: [
          { id: "e1", pattern: "/usr/bin/git", source: "openclaw", kind: "program" },
        ],
      });
      await page.goto(baseURL + settingsPath("capabilities", "allowlist"));
      await expect(allowlist(page).locator(".assistant-shell-entry")).toHaveCount(1);
      await expect(allowlist(page)).not.toContainText("remembers each always allowed");
    });
  });
}
