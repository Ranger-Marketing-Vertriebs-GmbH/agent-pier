import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { inboxFixture } from "./inbox-fixture.js";

const rows = (page) =>
  page.getByRole("navigation", { name: "Wartet auf dich" }).getByRole("button");

test("the inbox lists every source with counts per tab and stable addresses", async ({
  page,
}) => {
  await inboxFixture(page);
  await page.goto(baseURL + "/");
  const entry = page.getByRole("button", { name: "Eingang, 5 wartend", exact: true });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByRole("heading", { name: "Eingang", level: 1 })).toBeVisible();
  await expect(page.getByText("Wartet auf dich", { exact: true }).first()).toBeVisible();
  const tabs = page.getByRole("tablist", { name: "Eingang filtern" });
  for (const [name, count] of [
    ["Alle", 5],
    ["Fragen", 1],
    ["Freigaben", 1],
    ["Gates", 1],
    ["Agenten", 2],
  ])
    await expect(tabs.getByRole("tab", { name: `${name} ${count}` })).toBeVisible();
  await expect(rows(page)).toHaveCount(5);
  // The shell command expires in minutes, so it comes first; then the longest waiting.
  await expect(rows(page).first()).toContainText("Shell-Befehl");
  await expect(rows(page).first()).toContainText("Läuft in 4 Minuten ab");
  await expect(rows(page).nth(1)).toContainText("Review");
  await tabs.getByRole("tab", { name: "Agenten 2" }).click();
  await expect(page).toHaveURL(/\/inbox\?tab=agents$/);
  await expect(rows(page)).toHaveCount(2);
  await rows(page).filter({ hasText: "Review the release" }).click();
  await expect(page).toHaveURL(/\/inbox\/team\/proposal-one\?tab=agents$/);
  await expect(page.getByRole("button", { name: "Team freigeben" })).toBeVisible();
  // The address alone opens the same item after a reload.
  await page.reload();
  await expect(page.getByRole("button", { name: "Team freigeben" })).toBeVisible();
  await page.getByRole("button", { name: "Im Kontext öffnen" }).click();
  await expect(page).toHaveURL(/\/agents\/helper\/chats\/chat-1$/);
});

test("answering inline uses each source's own endpoint and the item leaves the list", async ({
  page,
}) => {
  const state = await inboxFixture(page);
  await page.goto(baseURL + "/inbox/approval/permit-beta");
  await expect(page.getByText("npm test", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Einmal erlauben", exact: true }).click();
  await expect(page.getByText("Bereits erledigt")).toBeVisible();
  await expect(page.getByText("Erlaubt", { exact: true })).toBeVisible();
  expect(
    state.calls.find((call) => call.path.endsWith("/permit-beta/answer")).body,
  ).toEqual({ expectedRevision: 1, choice: "allow" });
  await expect(rows(page)).toHaveCount(4);
  await expect(
    page.getByRole("button", { name: "Eingang, 4 wartend", exact: true }),
  ).toBeVisible();

  await rows(page).filter({ hasText: "Shell-Befehl" }).click();
  await expect(page.getByText("ls -la", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Einmal erlauben" }).click();
  await expect(page.getByText("Einmal erlaubt", { exact: true })).toBeVisible();
  expect(
    state.calls.find((call) => call.path === "/assistant-actions/exec-one/decision").body,
  ).toEqual({ revision: 1, decision: "allow-once" });

  await rows(page).filter({ hasText: "Review" }).first().click();
  await expect(page.getByText("Release the new version")).toBeVisible();
  // The gate shows the spec the stage wrote.
  await expect(page.getByText("The release notes are published.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Spec ersetzen" })).toBeVisible();
  await page.getByRole("button", { name: "Freigeben", exact: true }).click();
  await expect(page.getByText("Bereits erledigt")).toBeVisible();
  expect(
    state.calls.find((call) => call.path === "/pipeline-runs/run-one/gate").body,
  ).toEqual({ action: "accept" });
  await expect(rows(page)).toHaveCount(2);
  await expect(
    page.getByRole("tablist", { name: "Eingang filtern" }).getByRole("tab", {
      name: "Gates 0",
    }),
  ).toBeVisible();
});

test("a team proposal with agents switched off does not wait forever", async ({
  page,
}) => {
  await inboxFixture(page, { agents: false });
  await page.goto(baseURL + "/inbox/team/proposal-one");
  await expect(page.getByRole("heading", { name: "Wartet nicht mehr" })).toBeVisible();
  await expect(page.getByText("Eingang wird geladen …")).toHaveCount(0);
});

test("a stale address says the item no longer waits", async ({ page }) => {
  await inboxFixture(page);
  await page.goto(baseURL + "/inbox/question/answered-elsewhere");
  await expect(page.getByRole("heading", { name: "Wartet nicht mehr" })).toBeVisible();
});

test("on a phone in English the inbox opens from the header and answers in the detail", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await inboxFixture(page, { language: "en" });
  await page.goto(baseURL + "/");
  await page.getByRole("button", { name: "Open inbox, 5 waiting", exact: true }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  await expect(page.getByText("Waiting on you", { exact: true }).first()).toBeVisible();
  const tabs = page.getByRole("tablist", { name: "Filter inbox" });
  await expect(tabs.getByRole("tab", { name: "Approvals 1" })).toBeVisible();
  const list = page
    .getByRole("navigation", { name: "Waiting on you" })
    .getByRole("button");
  await expect(list).toHaveCount(5);
  await list.filter({ hasText: "Framework" }).click();
  await expect(page.getByText("Which framework should the app use?")).toBeVisible();
  await expect(list.first()).toBeHidden();
  await page.getByLabel("React", { exact: true }).check();
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  await expect(page.getByText("Already done")).toBeVisible();
  expect(
    state.calls.find((call) => call.path.endsWith("/ask-alpha/answer")).body,
  ).toEqual({
    expectedRevision: 1,
    answers: { q1: ["react"] },
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(list).toHaveCount(4);
  await list.filter({ hasText: "Shell command" }).click();
  await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.getByRole("button", { name: "Open in context" }).click();
  await expect(page).toHaveURL(/\/agents\/helper\/chats\/chat-1$/);
});

test.describe("the live inbox topic", () => {
  test.use({ live: "manual" });

  test("the start page shows a pushed Inbox item without GET /api/inbox", async ({
    page,
    liveStub,
  }) => {
    const state = await inboxFixture(page, { language: "en" });
    await page.goto(baseURL + "/");
    await liveStub.waitForSubscribe("state");
    liveStub.push(
      "state",
      await page.evaluate(() => fetch("/api/state").then((r) => r.json())),
    );
    await liveStub.waitForSubscribe("inbox");
    const needs = page.getByRole("region", { name: "Needs you" });
    liveStub.push("inbox", {
      instance: "fixture",
      revision: 7,
      counts: { all: 1, questions: 0, approvals: 0, gates: 1, agents: 0 },
      items: [
        {
          type: "gate",
          tab: "gates",
          id: "run-pushed",
          kind: "gate",
          status: "awaiting-human",
          revision: 3,
          source: { kind: "pipeline", id: "run-pushed", name: "Pushed", project: "app" },
          title: "Pushed review",
          stage: "review",
          createdAt: new Date(Date.now() - 60000).toISOString(),
          expiresAt: null,
          link: "/pipelines/runs/run-pushed",
        },
      ],
    });
    await expect(needs).toContainText("Pushed review");
    expect(state.calls.filter((call) => call.path === "/inbox")).toEqual([]);
  });

  test("a change reaches the inbox page through the topic with no GET /api/inbox", async ({
    page,
    liveStub,
  }) => {
    const state = await inboxFixture(page, { language: "en" });
    await page.goto(baseURL + "/inbox");
    await liveStub.waitForSubscribe("state");
    const workspace = await page.evaluate(() =>
      fetch("/api/state").then((r) => r.json()),
    );
    liveStub.push("state", workspace);
    await liveStub.waitForSubscribe("inbox");
    const item = (id, title) => ({
      type: "gate",
      tab: "gates",
      id,
      kind: "gate",
      status: "awaiting-human",
      revision: 1,
      source: { kind: "pipeline", id, name: id, project: "app" },
      title,
      stage: "review",
      createdAt: new Date(Date.now() - 60000).toISOString(),
      expiresAt: null,
      link: `/pipelines/runs/${id}`,
    });
    const list = (revision, items) => ({
      instance: "fixture",
      revision,
      counts: {
        all: items.length,
        questions: 0,
        approvals: 0,
        gates: items.length,
        agents: 0,
      },
      items,
    });
    const rows = page
      .getByRole("navigation", { name: "Waiting on you" })
      .getByRole("button");
    liveStub.push("inbox", list(7, [item("run-a", "First review")]));
    await expect(rows).toHaveCount(1);
    // Whatever the page read to begin with is behind it; a change reads nothing more.
    const reads = () => state.calls.filter((call) => call.path === "/inbox").length;
    const before = reads();
    // The workspace state announces the new revision before the list arrives, as the
    // server pushes both; the page must wait for the topic instead of reading the list.
    const next = list(8, [item("run-a", "First review"), item("run-b", "Second review")]);
    liveStub.push("state", {
      ...workspace,
      inbox: { instance: "fixture", revision: 8, counts: next.counts },
    });
    // The sidebar count shows the summary reached the page; the list follows.
    await expect(
      page.getByRole("button", { name: "Inbox, 2 waiting", exact: true }),
    ).toBeVisible();
    liveStub.push("inbox", next);
    await expect(rows).toHaveCount(2);
    await expect(page.getByText("Second review")).toBeVisible();
    expect(reads()).toBe(before);
  });
});
