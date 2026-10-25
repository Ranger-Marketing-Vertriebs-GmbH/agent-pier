import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

// "home" proposed a hook in its chat; the owner adjusts its rights and approves.
// The agent no longer has research but holds memory, so the card lets him tick
// memory on and sends research off (capped by the live ceiling).
const hookId = "0f8b6a52-3c1d-4e2f-9a7b-5d6c8e9f0a1b";
const proposal = (extra = {}) => ({
  id: "proposal-1",
  assistantId: "home",
  revision: 3,
  state: "awaiting_approval",
  createdAt: "2026-10-25T08:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  payload: {
    action: "hook_proposal",
    approval: true,
    name: "Zabbix",
    sender: "Zabbix server",
    reason: "You asked me to watch the NAS disks.",
    instruction: "Check the disk and tell me what to do.",
    rights: {
      notify: true,
      telegram: false,
      research: true,
      coding: false,
      memory: false,
      mcp: false,
      shell: "off",
      sshHosts: ["ssh-1"],
      folders: {},
    },
    hourlyLimit: 20,
  },
  ...extra,
});
const ceiling = {
  telegram: false,
  research: false,
  coding: false,
  memory: true,
  mcp: false,
  shell: "approval",
  sshHosts: ["ssh-1"],
  folders: {},
};
const words = {
  en: {
    title: "Hook proposal",
    reason: "Reason: You asked me to watch the NAS disks.",
    rights: ["Notify", "Research", "1 SSH host"],
    memory: "Write memory",
    research: "Research",
    approve: "Approve hook",
    created: "Hook “Zabbix” created.",
    link: "Show the secret in the hook's settings",
  },
  de: {
    title: "Hook-Vorschlag",
    reason: "Grund: You asked me to watch the NAS disks.",
    rights: ["Benachrichtigen", "Recherche", "1 SSH-Host"],
    memory: "Gedächtnis schreiben",
    research: "Recherche",
    approve: "Hook genehmigen",
    created: "Hook „Zabbix“ erstellt.",
    link: "Geheimnis in den Einstellungen des Hooks anzeigen",
  },
};

async function setup(page, language) {
  const state = await chatFixture(page, { language, actions: [proposal()] });
  const decisions = [];
  await page.route(/\/api\/assistants\/home\/hooks$/, (route) =>
    route.fulfill({ json: { hooks: [], ceiling, shellChoices: ["off", "approval"] } }),
  );
  await page.route(/\/api\/assistant-actions\/proposal-1\/decision$/, (route) => {
    decisions.push(route.request().postDataJSON());
    state.actions = [];
    return route.fulfill({
      json: proposal({ revision: 4, state: "completed", result: { hookId } }),
    });
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  return decisions;
}

for (const language of ["en", "de"])
  test(`the proposal card approves with an edited tick and links to settings (${language})`, async ({
    page,
  }) => {
    const t = words[language];
    const decisions = await setup(page, language);
    const card = page.locator("[data-hook-proposal]");
    await expect(card.locator(".assistant-approval-head strong")).toHaveText(t.title);
    await expect(card.locator(".assistant-approval-title")).toHaveText(
      "Zabbix · Zabbix server",
    );
    await expect(card.locator(".assistant-approval-task")).toHaveText(t.reason);
    await expect(card.locator(".permission-list li")).toHaveText(t.rights);
    // Memory is within the agent's rights; research is not, so it can only go off.
    const memory = card.getByRole("checkbox", { name: t.memory });
    const research = card.getByRole("checkbox", { name: t.research });
    await expect(memory).toBeEnabled();
    await expect(research).toBeChecked();
    await expect(card.getByRole("checkbox", { name: /Telegram/ })).toBeDisabled();
    await memory.check();
    await card.getByRole("button", { name: t.approve }).click();
    await expect.poll(() => decisions.length).toBe(1);
    expect(decisions[0]).toEqual({
      revision: 3,
      decision: "approve",
      rights: {
        notify: true,
        telegram: false,
        research: false,
        coding: false,
        memory: true,
        mcp: false,
        shell: "off",
        sshHosts: ["ssh-1"],
        folders: {},
      },
    });
    const created = page.locator("[data-hook-created]");
    await expect(created).toContainText(t.created);
    const link = created.getByRole("link", { name: t.link });
    await expect(link).toHaveAttribute(
      "href",
      `/agents/home/settings?tab=routines&page=hook&hook=${hookId}`,
    );
    await expect(page.locator("[data-hook-proposal]")).toHaveCount(0);
    await link.click();
    await expect(page).toHaveURL(
      /\/agents\/home\/settings\?tab=routines&page=hook&hook=/,
    );
  });

test("an unedited approval sends no rights", async ({ page }) => {
  const decisions = await setup(page, "en");
  await page.getByRole("button", { name: "Approve hook" }).click();
  await expect.poll(() => decisions.length).toBe(1);
  expect(decisions[0]).toEqual({ revision: 3, decision: "approve" });
});

test("hook proposal card screenshot", async ({ page }, info) => {
  test.skip(!process.env.EVENT_AREA_SHOTS, "Screenshots are taken on request.");
  await setup(page, "en");
  const card = page.locator("[data-hook-proposal]");
  await expect(card.getByRole("checkbox").first()).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("f-hook-proposal.png") });
});

test("the action history lists a decided proposal with its hook and outcome", async ({
  page,
}) => {
  await chatFixture(page, {
    actions: [
      proposal({ id: "p-done", state: "completed", result: { hookId } }),
      proposal({ id: "p-failed", state: "failed", diagnostic: "RIGHTS_CHANGED" }),
    ],
  });
  await page.goto(baseURL + "/agents/home/settings?tab=work&page=actions");
  const rows = page.locator("[data-hook-proposal-row]");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator("h3")).toHaveText("Hook proposal: Zabbix");
  await expect(rows.nth(0)).toContainText("Sender: Zabbix server");
  await expect(rows.nth(0)).toContainText("Failed");
  await expect(rows.nth(0)).toContainText(
    "The agent no longer holds every right of this proposal.",
  );
  await expect(rows.nth(1)).toContainText("Completed");
  // Never the memory card the history used to fall back to.
  await expect(page.locator(".assistant-memory-text")).toHaveCount(0);
});
