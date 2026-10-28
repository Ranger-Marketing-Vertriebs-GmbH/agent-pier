import { test, expect } from "@playwright/test";
import { setup } from "./assistant-shell-fixture.js";
import { openChat } from "./assistant-ssh-fixture.js";

// The agent chat's mail card (MailApprovalCard), in English, on an intercepted feed.
const mailAction = (id, extra = {}) => ({
  id,
  revision: 3,
  assistantId: "home",
  state: "awaiting_approval",
  createdAt: "2026-10-27T10:00:00.000Z",
  expiresAt: "2026-10-28T10:00:00.000Z",
  ...extra,
  payload: {
    action: "mail_send",
    accountId: "acc-1",
    accountName: "Private",
    from: { name: "Home Agent", address: "agent@example.com" },
    // A display name that looks like another address: the card shows the real one.
    to: ['"bob@example.org" <eve@evil.net>'],
    cc: [],
    bcc: ["dana@example.net"],
    subject: "Offer",
    body: "Dear Bob,\nhere is the offer.",
    originClass: "owner",
    trusted: false,
    ...extra.payload,
  },
});
const mailCard = (page) => page.getByRole("article", { name: "Send email?" });

test("the card shows the mail and Send posts the decision with its revision", async ({
  page,
}) => {
  const state = await setup(page, { actions: [mailAction("m1")] });
  await openChat(page);
  const card = mailCard(page);
  await expect(card.getByRole("status")).toHaveText("Waiting for you");
  await expect(card).toContainText("Private");
  await expect(card).toContainText("agent@example.com");
  await expect(card.locator("[data-field=to] code")).toHaveText("eve@evil.net");
  await expect(card.locator("[data-field=to]")).toContainText("(bob@example.org)");
  await expect(card.locator("[data-field=bcc] code")).toHaveText("dana@example.net");
  await expect(card.locator("[data-field=cc]")).toHaveCount(0);
  await expect(card.locator("[data-field=subject]")).toHaveText("Offer");
  await expect(card.getByLabel("Message")).toHaveText("Dear Bob,\nhere is the offer.");
  await expect(card).toContainText("A chat message never does.");
  const buttons = card.locator(".assistant-card-actions").getByRole("button");
  await expect(buttons).toHaveText(["Send", "Don't send"]);
  await card.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(() => state.decisions)
    .toEqual([["m1", { revision: 3, decision: "approve" }]]);
});

test("after Don't send the card reads Not sent · draft kept", async ({ page }) => {
  const state = await setup(page, { actions: [mailAction("m1")] });
  await page.route(/\/api\/assistant-actions\/m1\/decision$/, (route) => {
    state.decisions.push(["m1", route.request().postDataJSON()]);
    state.actions = [];
    return route.fulfill({
      json: mailAction("m1", { revision: 4, state: "declined" }),
    });
  });
  await openChat(page);
  const card = mailCard(page);
  await card.getByRole("button", { name: "Don't send" }).click();
  await expect(card.getByRole("status")).toHaveText("Not sent · draft kept");
  await expect(card.getByRole("button")).toHaveCount(0);
  expect(state.decisions).toEqual([["m1", { revision: 3, decision: "decline" }]]);
});

test("hidden characters show as codes and a long body must be shown before Send", async ({
  page,
}) => {
  const body = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}`).join("\n");
  await setup(page, {
    actions: [mailAction("m1", { payload: { subject: "Hi​ there", body } })],
  });
  await openChat(page);
  const card = mailCard(page);
  await expect(card.locator("[data-field=subject]")).toContainText("U+200B");
  await expect(card).toContainText("Contains hidden characters.");
  const send = card.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeDisabled();
  await card.getByRole("button", { name: "Show all" }).click();
  await expect(send).toBeEnabled();
});

test("an approved email shows Sending while it goes out; a rule send shows no card", async ({
  page,
}) => {
  await setup(page, {
    actions: [
      mailAction("m1", { state: "executing" }),
      mailAction("m2", { state: "executing", payload: { trusted: true } }),
    ],
  });
  await openChat(page);
  const card = mailCard(page);
  await expect(card).toHaveCount(1);
  await expect(card.getByRole("status")).toHaveText("Sending …");
  await expect(card.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
});

test("after Send the chat keeps a note with the outcome", async ({ page }) => {
  const state = await setup(page, { actions: [mailAction("m1")] });
  const history = { messages: [] };
  await page.route(/\/messages(\?|$)/, (route) =>
    route.fulfill({ json: { messages: history.messages, requests: [], stale: false } }),
  );
  await openChat(page);
  await mailCard(page).getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.decisions.length).toBe(1);
  history.messages = [
    {
      id: "mail-run:m1",
      role: "event",
      event: "mail-run",
      actionId: "m1",
      state: "completed",
      code: null,
      accountName: "Private",
      recipientCount: 2,
      subject: "Offer",
      timestamp: 1761559200000,
      runId: null,
    },
  ];
  await page.evaluate(() => window.agentFeed.push("chat"));
  const row = page.locator("[data-mail-run]");
  await expect(row).toHaveAttribute("data-mail-run", "completed");
  await expect(row.getByRole("button")).toContainText("Offer");
  await expect(row.getByRole("button")).toContainText("Sent");
  await expect(mailCard(page)).toHaveCount(0);
  await row.getByRole("button").click();
  await expect(row).toContainText("Private");
  await expect(row).toContainText("2");
  await expect(row).not.toContainText("eve@evil.net");
  // The note stays when the feed reads the chat again.
  await page.evaluate(() => window.agentFeed.push("chat"));
  await expect(row).toContainText("Sent");
});

test("a declined card shown here gives way to its note", async ({ page }) => {
  const state = await setup(page, { actions: [mailAction("m1")] });
  const history = { messages: [] };
  await page.route(/\/messages(\?|$)/, (route) =>
    route.fulfill({ json: { messages: history.messages, requests: [], stale: false } }),
  );
  await page.route(/\/api\/assistant-actions\/m1\/decision$/, (route) => {
    state.actions = [];
    return route.fulfill({ json: mailAction("m1", { revision: 4, state: "declined" }) });
  });
  await openChat(page);
  await mailCard(page).getByRole("button", { name: "Don't send" }).click();
  await expect(mailCard(page).getByRole("status")).toHaveText("Not sent · draft kept");
  history.messages = [
    {
      id: "mail-run:m1",
      role: "event",
      event: "mail-run",
      actionId: "m1",
      state: "declined",
      code: null,
      accountName: "Private",
      recipientCount: 2,
      subject: "Offer",
      timestamp: 1761559200000,
      runId: null,
    },
  ];
  await page.evaluate(() => window.agentFeed.push("chat"));
  await expect(page.locator("[data-mail-run=declined]")).toContainText(
    "Not sent · draft kept",
  );
  await expect(mailCard(page)).toHaveCount(0);
});

const hash = "ab".repeat(32);
const withFiles = {
  subject: "Fwd: Ihre Rechnung",
  forward: {
    from: { name: "Telekom", address: "rechnung@telekom.de" },
    subject: "Ihre Rechnung",
    date: "2026-10-27T09:00:00.000Z",
    folder: "INBOX",
    uid: 7,
    htmlIncluded: true,
    htmlOmitted: false,
  },
  html: { part: "1.2", partSha256: "cd".repeat(32) },
  attachments: [
    {
      name: "offer.pdf",
      size: 12000,
      type: "application/pdf",
      sha256: hash,
      part: "2",
      partSha256: "ef".repeat(32),
      source: {
        kind: "project",
        projectId: "p1",
        projectName: "Website",
        path: "docs/offers/2026/october/offer-for-bob-with-a-rather-long-name.pdf",
      },
    },
    {
      name: "invoice.pdf",
      size: 2048,
      type: "application/pdf",
      sha256: "12".repeat(32),
      part: "3",
      partSha256: "34".repeat(32),
      source: { kind: "original" },
    },
  ],
};

test("the card lists attachments and a forward", async ({ page }) => {
  await setup(page, { actions: [mailAction("m2", { payload: withFiles })] });
  await openChat(page);
  const card = mailCard(page);
  const rows = card.locator("[data-field=attachment]");
  await expect(rows).toHaveCount(2);
  await expect(card.getByRole("region", { name: "Attachments" })).toBeVisible();
  await expect(rows.nth(0)).toContainText("offer.pdf");
  await expect(rows.nth(0)).toContainText("11.7 kB");
  await expect(rows.nth(0)).toContainText("application/pdf");
  await expect(rows.nth(0)).toContainText(
    "docs/offers/2026/october/offer-for-bob-with-a-rather-long-name.pdf (Website)",
  );
  await expect(rows.nth(0).locator("code.mail-approval-hash")).toHaveText(hash);
  await expect(rows.nth(1)).toContainText("From the original mail");
  await expect(card).toContainText("Forward of");
  await expect(card.locator("[data-field=forward] code")).toHaveText(
    "rechnung@telekom.de",
  );
  await expect(card.locator("[data-field=forward]")).toContainText("Ihre Rechnung");
  await expect(card).toContainText(
    "Includes the original's HTML version, which is not shown here.",
  );
  await expect(card).not.toContainText("Contains hidden characters.");
  // At phone width the hash wraps inside the card; the page never scrolls sideways.
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(rows.nth(0).locator("code.mail-approval-hash")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await rows.nth(0).locator("code.mail-approval-hash").boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(375);
});

test("a draft's part, a left-out HTML version and a hidden name show as such", async ({
  page,
}) => {
  const payload = {
    forward: { ...withFiles.forward, htmlIncluded: false, htmlOmitted: true },
    attachments: [
      { ...withFiles.attachments[1], name: "in‮voice.pdf", source: { kind: "draft" } },
    ],
  };
  await setup(page, { actions: [mailAction("m3", { payload })] });
  await openChat(page);
  const card = mailCard(page);
  await expect(card.locator("[data-field=attachment]")).toContainText(
    "Already in the draft",
  );
  await expect(card.locator("[data-field=attachment]")).toContainText("U+202E");
  await expect(card).toContainText("Contains hidden characters.");
  await expect(card).toContainText("The original's HTML version is left out");
  await expect(card).not.toContainText("Includes the original's HTML version");
});

test("in German the card names the attachments and the forward", async ({ page }) => {
  await setup(page, { actions: [mailAction("m2", { payload: withFiles })] });
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "de"));
  await openChat(page);
  const card = page.getByRole("article", { name: "E-Mail senden?" });
  await expect(card.getByRole("region", { name: "Anhänge" })).toBeVisible();
  await expect(card).toContainText("Weiterleitung von");
  await expect(card).toContainText("Aus der ursprünglichen E-Mail");
  await expect(card).toContainText("Enthält die HTML-Fassung des Originals");
});
