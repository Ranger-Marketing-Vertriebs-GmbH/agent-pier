import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

// "home" proposed an SSH access in its chat; the owner checks the fingerprint, picks
// the project's key and a mode, and confirms. AgentPier answers with the public key
// he has to install on the server.
const fingerprint = "SHA256:Q2hlY2sgdGhpcyBmaW5nZXJwcmludCBjYXJlZnVsbHk";
const publicKey =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyForTheBrowserSpecOnly0123456789";
const proposal = (extra = {}) => ({
  id: "proposal-1",
  assistantId: "home",
  revision: 3,
  state: "awaiting_approval",
  createdAt: "2026-10-26T08:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  payload: {
    action: "ssh_access",
    approval: true,
    name: "Backup NAS",
    host: "nas.example.test",
    port: 2222,
    username: "backup",
    purpose: "You asked me to check the nightly backup logs.",
    projectId: "project-1",
    projectName: "Homelab",
    hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyOfTheSpec",
    hostFingerprint: fingerprint,
  },
  ...extra,
});
const keys = [
  { id: "key-deploy", name: "Deploy", projectId: "project-1", publicKey },
  { id: "key-other", name: "Elsewhere", projectId: null, publicKey },
];
const words = {
  en: {
    title: "SSH access proposal",
    login: "backup@nas.example.test:2222",
    verify: /through a channel you trust/,
    key: "Key",
    mode: "Mode",
    newKey: "New managed key",
    trusted: "Trusted",
    warning: /without your confirmation/,
    approve: "Confirm access",
    created: "SSH access “Backup NAS” created.",
    install: /authorized_keys/,
  },
  de: {
    title: "SSH-Zugangsvorschlag",
    login: "backup@nas.example.test:2222",
    verify: /über einen Weg, dem du vertraust/,
    key: "Schlüssel",
    mode: "Modus",
    newKey: "Neuer verwalteter Schlüssel",
    trusted: "Vertraut",
    warning: /ohne deine Bestätigung/,
    approve: "Zugang bestätigen",
    created: "SSH-Zugang „Backup NAS“ angelegt.",
    install: /authorized_keys/,
  },
};

async function setup(page, language, action = proposal()) {
  const state = await chatFixture(page, { language, actions: [action] });
  const decisions = [];
  await page.route(/\/api\/ssh-keys$/, (route) => route.fulfill({ json: { keys } }));
  await page.route(/\/api\/assistant-actions\/proposal-1\/decision$/, (route) => {
    decisions.push(route.request().postDataJSON());
    state.actions = [];
    return route.fulfill({
      json: proposal({
        revision: 4,
        state: "completed",
        result: { accessId: "access-1", publicKey, mode: "trusted", keyCreated: false },
      }),
    });
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  return decisions;
}

for (const language of ["en", "de"])
  test(`the proposal card shows the fingerprint and confirms with a key and mode (${language})`, async ({
    page,
  }) => {
    const t = words[language];
    const decisions = await setup(page, language);
    const card = page.locator("[data-ssh-access-proposal]");
    await expect(card.locator(".assistant-approval-head strong")).toHaveText(t.title);
    await expect(card.locator(".assistant-approval-title")).toHaveText("Backup NAS");
    await expect(card.locator("code").first()).toHaveText(t.login);
    await expect(card).toContainText("Homelab");
    await expect(card).toContainText("nightly backup logs");
    await expect(card.locator("[data-ssh-access-fingerprint]")).toHaveText(fingerprint);
    await expect(card.locator("[data-ssh-access-verify]")).toHaveText(t.verify);
    // Only keys of the proposal's project are offered next to a new managed key.
    const key = card.getByRole("combobox", { name: t.key });
    await expect(key).toBeEnabled();
    await expect(key.locator("option")).toHaveText([t.newKey, "Deploy"]);
    await key.selectOption("key-deploy");
    await expect(card.locator("[data-ssh-access-trusted]")).toHaveCount(0);
    await card.getByRole("combobox", { name: t.mode }).selectOption("trusted");
    await expect(card.locator("[data-ssh-access-trusted]")).toHaveText(t.warning);
    await card.getByRole("button", { name: t.approve }).click();
    await expect.poll(() => decisions.length).toBe(1);
    expect(decisions[0]).toEqual({
      revision: 3,
      decision: "approve",
      keyId: "key-deploy",
      mode: "trusted",
    });
    const created = page.locator("[data-ssh-access-created]");
    await expect(created).toContainText(t.created);
    await expect(created.locator("pre")).toHaveText(publicKey);
    await expect(created).toContainText(t.install);
    await expect(page.locator("[data-ssh-access-proposal]")).toHaveCount(0);
  });

test("an unchanged confirmation sends only the decision", async ({ page }) => {
  const decisions = await setup(page, "en");
  await expect(page.getByRole("combobox", { name: "Key" })).toBeEnabled();
  await page.getByRole("button", { name: "Confirm access" }).click();
  await expect.poll(() => decisions.length).toBe(1);
  expect(decisions[0]).toEqual({ revision: 3, decision: "approve" });
});

test("keys that cannot be loaded leave a new managed key to confirm", async ({
  page,
}) => {
  await chatFixture(page, { actions: [proposal()] });
  await page.route(/\/api\/ssh-keys$/, (route) =>
    route.fulfill({ status: 500, json: { error: "boom" } }),
  );
  await page.goto(baseURL + "/agents/home/chats/dinner");
  const card = page.locator("[data-ssh-access-proposal]");
  await expect(card.locator(".error")).toContainText(
    "The project's keys could not be loaded.",
  );
  await expect(card.getByRole("button", { name: "Confirm access" })).toBeEnabled();
});

test("the action history lists decided proposals with outcome and public key", async ({
  page,
}) => {
  await chatFixture(page, {
    actions: [
      proposal({
        id: "p-done",
        state: "completed",
        result: { accessId: "access-1", publicKey, mode: "approval" },
      }),
      proposal({ id: "p-failed", state: "failed", diagnostic: "HOST_KEY_CHANGED" }),
    ],
  });
  await page.goto(baseURL + "/agents/home/settings?tab=work&page=actions");
  const rows = page.locator("[data-ssh-access-row]");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator("h3")).toHaveText("SSH access proposal: Backup NAS");
  await expect(rows.nth(0)).toContainText("Failed");
  await expect(rows.nth(0)).toContainText("The agent has to propose the access again.");
  await expect(rows.nth(1)).toContainText("Completed");
  await expect(rows.nth(1).locator("pre")).toHaveText(publicKey);
});

test("SSH access proposal card screenshot", async ({ page }, info) => {
  test.skip(!process.env.EVENT_AREA_SHOTS, "Screenshots are taken on request.");
  await setup(page, "en");
  const card = page.locator("[data-ssh-access-proposal]");
  await expect(card.getByRole("combobox", { name: "Key" })).toBeEnabled();
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("f-ssh-access-proposal.png") });
});
