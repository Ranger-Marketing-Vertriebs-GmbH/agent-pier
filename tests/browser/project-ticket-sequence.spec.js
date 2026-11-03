import { test, expect } from "../helpers/browser-test.js";
import { baseURL as base } from "../helpers/browser.js";
import { ticketsFixture } from "./tickets-fixture.js";

const item = (id, key, title, state, extra = {}) => ({
  id,
  source: key.includes("#") ? "github" : "plane",
  key,
  title,
  url: "https://github.com/acme/app/issues/1",
  kind: "session",
  origin: { kind: "manual" },
  state,
  addedAt: 1000,
  options: { allowMerge: false },
  rounds: { failed: 0 },
  ...extra,
});

const parked = item("i1", "acme/app#7", "Fix the login", "needs-owner", {
  sessionId: "s1",
  pr: { number: 12, url: "https://github.com/acme/app/pull/12" },
  needsOwner: { reason: "failedRounds", at: 2000 },
});
const queueOf = (...items) => ({ queue: { items }, defaults: { repair: null } });
const fullQueue = queueOf(
  parked,
  item("i2", "AP-3", "Add export", "waiting"),
  item("i3", "acme/app#9", "Started issue", "awaiting-merge", {
    kind: "pipeline",
    runId: "r9",
    pr: { number: 14, url: "https://github.com/acme/app/pull/14" },
  }),
  item("i4", "AP-4", "Refused item", "done"),
);

const queueCard = (page) => page.getByRole("group", { name: /^(Warteschlange|Queue)$/ });
const queueMenu = (page, key, lang = "de") =>
  page.getByRole("button", {
    name:
      lang === "de"
        ? `Aktionen in der Warteschlange für ${key}`
        : `Queue actions for ${key}`,
    exact: true,
  });

test("the queue shows states and a reason", async ({ page }) => {
  await ticketsFixture(page, { queue: fullQueue });
  await page.goto(base + "/projects/m1?tab=tickets");
  const card = queueCard(page);
  await expect(card).toBeVisible();
  await expect(card.getByText("acme/app#7 Fix the login")).toBeVisible();
  await expect(card.getByText("Braucht dich", { exact: true })).toBeVisible();
  await expect(card.getByText("Die Checks sind dreimal fehlgeschlagen.")).toBeVisible();
  await expect(card.getByText("Wartet", { exact: true })).toBeVisible();
  await expect(card.getByText("Wartet auf Merge", { exact: true })).toBeVisible();
  await expect(card.getByText("Pull Request #14")).toBeVisible();
  await expect(card.getByText("Erledigt", { exact: true })).toBeVisible();
  // The queue sits above the ticket list.
  const queueBox = await card.boundingBox();
  const listBox = await page.getByText("acme/app#7 Fix the login").last().boundingBox();
  expect(queueBox.y).toBeLessThan(listBox.y);

  // A parked ticket offers Retry, Mark done and Remove; a running one none of them.
  await queueMenu(page, "acme/app#7").click();
  for (const name of [
    "Erneut versuchen",
    "Als erledigt markieren",
    "Aus der Warteschlange entfernen",
    "Session öffnen",
    "Pull Request öffnen",
  ])
    await expect(page.getByRole("menuitem", { name })).toBeVisible();
  await page.keyboard.press("Escape");
  await queueMenu(page, "acme/app#9").click();
  await expect(page.getByRole("menuitem", { name: "Lauf öffnen" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Erneut versuchen" })).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Aus der Warteschlange entfernen" }),
  ).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Lauf öffnen" }).click();
  await expect(page).toHaveURL(/\/pipelines\/runs\/r9$/);
});

test("an empty queue shows nothing", async ({ page }) => {
  await ticketsFixture(page, {});
  await page.goto(base + "/projects/m1?tab=tickets");
  await expect(page.getByText("acme/app#7 Fix the login")).toBeVisible();
  await expect(queueCard(page)).toHaveCount(0);
});

test("retry posts and the row follows the topic", async ({ page, liveStub }) => {
  let current = queueOf(parked);
  const { queueCalls } = await ticketsFixture(page, {
    queue: () => current,
    queueAction: () => {
      current = queueOf({ ...parked, state: "awaiting-merge", needsOwner: undefined });
      return undefined;
    },
  });
  await page.goto(base + "/projects/m1?tab=tickets");
  const card = queueCard(page);
  await expect(card.getByText("Braucht dich", { exact: true })).toBeVisible();
  await queueMenu(page, "acme/app#7").click();
  await page.getByRole("menuitem", { name: "Erneut versuchen" }).click();
  await expect.poll(() => queueCalls.length).toBe(1);
  expect(queueCalls[0]).toMatchObject({
    method: "POST",
    path: "/tickets/projects/m1/queue/i1/retry",
  });
  await liveStub.reread("tickets.queue:m1");
  await expect(card.getByText("Wartet auf Merge", { exact: true })).toBeVisible();
  await expect(card.getByText("Die Checks sind dreimal fehlgeschlagen.")).toHaveCount(0);
});

test("a refused retry shows the server's reason", async ({ page }) => {
  await ticketsFixture(page, {
    queue: queueOf(parked),
    queueAction: () => ({
      status: 409,
      json: { error: "Dieses Ticket wird gerade bearbeitet." },
    }),
  });
  await page.goto(base + "/projects/m1?tab=tickets");
  await queueMenu(page, "acme/app#7").click();
  await page.getByRole("menuitem", { name: "Erneut versuchen" }).click();
  await expect(page.getByText("Dieses Ticket wird gerade bearbeitet.")).toBeVisible();
});

test("remove asks first", async ({ page, liveStub }) => {
  let current = queueOf(parked, item("i2", "AP-3", "Add export", "waiting"));
  const { queueCalls } = await ticketsFixture(page, {
    queue: () => current,
    queueAction: (call) => {
      if (call.method === "DELETE") current = queueOf(parked);
      if (call.path.endsWith("/done"))
        current = queueOf({ ...parked, state: "done", needsOwner: undefined });
      return undefined;
    },
  });
  await page.goto(base + "/projects/m1?tab=tickets");
  const card = queueCard(page);
  await queueMenu(page, "AP-3").click();
  await page.getByRole("menuitem", { name: "Aus der Warteschlange entfernen" }).click();
  const confirm = page.getByRole("dialog", {
    name: "AP-3 aus der Warteschlange entfernen?",
  });
  await expect(confirm).toBeVisible();
  // Cancel sends nothing.
  await confirm.getByRole("button", { name: "Abbrechen" }).click();
  await expect(confirm).toHaveCount(0);
  expect(queueCalls).toEqual([]);
  await queueMenu(page, "AP-3").click();
  await page.getByRole("menuitem", { name: "Aus der Warteschlange entfernen" }).click();
  await confirm.getByRole("button", { name: "Entfernen", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  expect(queueCalls).toEqual([
    { method: "DELETE", path: "/tickets/projects/m1/queue/i2", body: undefined },
  ]);
  await expect(card.getByText("AP-3 Add export")).toHaveCount(0);

  // Mark done asks too, then posts.
  await queueMenu(page, "acme/app#7").click();
  await page.getByRole("menuitem", { name: "Als erledigt markieren" }).click();
  const done = page.getByRole("dialog", { name: "acme/app#7 als erledigt markieren?" });
  await expect(done.getByText(/In GitHub oder Plane wird nichts/)).toBeVisible();
  await done.getByRole("button", { name: "Als erledigt markieren" }).click();
  await expect(done).toHaveCount(0);
  expect(queueCalls.at(-1)).toMatchObject({
    method: "POST",
    path: "/tickets/projects/m1/queue/i1/done",
  });
  await liveStub.reread("tickets.queue:m1");
  await expect(card.getByText("Erledigt", { exact: true })).toBeVisible();
});

test("in English the queue reads in English", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await ticketsFixture(page, {
    queue: queueOf(
      { ...parked, needsOwner: { reason: "idle", at: 2000 } },
      item("i2", "AP-3", "Add export", "waiting"),
      item("i5", "AP-5", "Later", "running"),
      item("i6", "AP-6", "Unknown", "needs-owner", {
        needsOwner: { reason: "somethingNew", at: 1 },
      }),
    ),
  });
  await page.goto(base + "/projects/m1?tab=tickets");
  const card = queueCard(page);
  await expect(card).toBeVisible();
  await expect(card.getByText("Needs you", { exact: true })).toHaveCount(2);
  await expect(
    card.getByText("The pull request stayed red for 30 minutes."),
  ).toBeVisible();
  await expect(card.getByText("AgentPier needs your decision.")).toBeVisible();
  await expect(card.getByText("Waiting", { exact: true })).toBeVisible();
  await expect(card.getByText("Running", { exact: true })).toBeVisible();
  await queueMenu(page, "acme/app#7", "en").click();
  for (const name of [
    "Retry",
    "Mark done",
    "Remove from queue",
    "Open session",
    "Open pull request",
  ])
    await expect(page.getByRole("menuitem", { name, exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Remove from queue" }).click();
  const confirm = page.getByRole("dialog", {
    name: "Remove acme/app#7 from the queue?",
  });
  await expect(
    confirm.getByText(/Its session, pull request and tracker entry stay/),
  ).toBeVisible();
  await expect(
    confirm.getByRole("button", { name: "Remove", exact: true }),
  ).toBeVisible();
});
