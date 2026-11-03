import { test, expect } from "../helpers/browser-test.js";
import { baseURL as base } from "../helpers/browser.js";
import { ticketsFixture } from "./tickets-fixture.js";

// The "Label rules" section of the Tickets tab, in English.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
});

const session = {
  tool: "codex",
  accountId: "local-codex",
  launchMode: "yolo",
  agentbus: true,
  agentpierTools: true,
  sshAccessIds: [],
};
const rule = (id, label, extra = {}) => ({
  id,
  source: "github",
  label,
  kind: "session",
  options: { allowMerge: false, session },
  paused: false,
  createdAt: 1000,
  updatedAt: 1000,
  picked: 0,
  status: { checkedAt: null, error: null },
  ...extra,
});
const agent = rule("r1", "agent", { picked: 3 });
const planeRule = rule("r2", "ready", {
  source: "plane",
  kind: "pipeline",
  options: { allowMerge: true, pipeline: { pipelineId: "p1" } },
  paused: true,
  picked: 1,
});

const rulesCard = (page) => page.getByRole("group", { name: "Label rules" });
const ruleMenu = (page, label) =>
  page.getByRole("button", { name: `Actions for label rule ${label}`, exact: true });

test("lists rules with state and picked count", async ({ page }) => {
  await ticketsFixture(page, { rules: { rules: [agent, planeRule] } });
  await page.goto(base + "/projects/m1?tab=tickets");
  const card = rulesCard(page);
  await expect(card.getByText("agent · GitHub")).toBeVisible();
  await expect(card.getByText("Session · 3 tickets picked up")).toBeVisible();
  await expect(card.getByText("Active", { exact: true })).toBeVisible();
  await expect(card.getByText("ready · Plane")).toBeVisible();
  await expect(
    card.getByText("Entwicklungsablauf · Allow merge · 1 ticket picked up"),
  ).toBeVisible();
  await expect(card.getByText("Paused", { exact: true })).toBeVisible();
  // The rules sit below the queue and above the ticket list.
  const rulesBox = await card.boundingBox();
  const listBox = await page.getByText("acme/app#7 Fix the login").boundingBox();
  expect(rulesBox.y).toBeLessThan(listBox.y);
});

test("without rules the section says what a rule does", async ({ page }) => {
  await ticketsFixture(page, {});
  await page.goto(base + "/projects/m1?tab=tickets");
  await expect(page.getByText(/^No label rules yet\./)).toBeVisible();
  await expect(page.getByRole("button", { name: "Add label rule" })).toBeVisible();
});

test("add rule sends allowMerge false by default and the chosen label", async ({
  page,
  liveStub,
}) => {
  let current = { rules: [] };
  const { ruleCalls } = await ticketsFixture(page, {
    rules: () => current,
    ruleAction: (call) => {
      current = { rules: [rule("r9", call.body.label, { source: call.body.source })] };
      return undefined;
    },
  });
  await page.goto(base + "/projects/m1?tab=tickets");
  await page.getByRole("button", { name: "Add label rule" }).click();
  const dialog = page.getByRole("dialog", { name: "Add label rule" });
  await expect(dialog).toBeVisible();
  const label = dialog.getByRole("textbox", { name: "Label" });
  await expect(label).toHaveAccessibleDescription(
    "Exact label name; existing open tickets with it are picked up too.",
  );
  await expect(dialog.getByRole("radio", { name: "GitHub" })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Session" })).toBeChecked();
  await expect(dialog.getByRole("switch", { name: "Allow merge" })).not.toBeChecked();
  await expect(dialog.getByRole("switch", { name: "Paused" })).not.toBeChecked();
  // No label yet: nothing to save.
  await expect(dialog.getByRole("button", { name: "Save rule" })).toBeDisabled();
  await dialog.getByRole("radio", { name: "Plane" }).check();
  await label.fill("  agent ready ");
  await dialog.getByRole("button", { name: "Save rule" }).click();
  await liveStub.reread("tickets.rules:m1");
  await expect(dialog).toHaveCount(0);
  expect(ruleCalls).toHaveLength(1);
  expect(ruleCalls[0]).toEqual({
    method: "POST",
    path: "/tickets/projects/m1/rules",
    body: {
      source: "plane",
      label: "agent ready",
      paused: false,
      kind: "session",
      allowMerge: false,
      session,
    },
  });
  await expect(rulesCard(page).getByText("agent ready · Plane")).toBeVisible();
});

test("a refused rule keeps the dialog open with the server's reason", async ({
  page,
}) => {
  await ticketsFixture(page, {
    ruleAction: () => ({
      status: 409,
      json: { error: "This label already has a rule." },
    }),
  });
  await page.goto(base + "/projects/m1?tab=tickets");
  await page.getByRole("button", { name: "Add label rule" }).click();
  const dialog = page.getByRole("dialog", { name: "Add label rule" });
  await dialog.getByRole("textbox", { name: "Label" }).fill("agent");
  await dialog.getByRole("button", { name: "Save rule" }).click();
  await expect(dialog.getByText("This label already has a rule.")).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Label" })).toHaveValue("agent");
});

test("edit prefills label and session", async ({ page }) => {
  const saved = rule("r1", "agent", {
    options: {
      allowMerge: true,
      session: { ...session, nativeModelId: "gpt-5.1", launchMode: "default" },
    },
  });
  const { ruleCalls } = await ticketsFixture(page, {
    rules: { rules: [saved, planeRule] },
  });
  await page.goto(base + "/projects/m1?tab=tickets");
  await ruleMenu(page, "agent").click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit label rule" });
  await expect(dialog.getByRole("textbox", { name: "Label" })).toHaveValue("agent");
  await expect(dialog.getByRole("radio", { name: "GitHub" })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Session" })).toBeChecked();
  await expect(dialog.getByLabel("Native model (optional)")).toHaveValue("gpt-5.1");
  await expect(dialog.getByRole("switch", { name: "Allow merge" })).toBeChecked();
  await dialog.getByRole("textbox", { name: "Label" }).fill("agent-go");
  await dialog.getByRole("button", { name: "Save rule" }).click();
  await expect(dialog).toHaveCount(0);
  expect(ruleCalls).toEqual([
    {
      method: "PUT",
      path: "/tickets/projects/m1/rules/r1",
      body: {
        source: "github",
        label: "agent-go",
        paused: false,
        kind: "session",
        allowMerge: true,
        session: { ...session, nativeModelId: "gpt-5.1", launchMode: "default" },
      },
    },
  ]);

  // A pipeline rule comes back with its pipeline.
  await ruleMenu(page, "ready").click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const pipeline = page.getByRole("dialog", { name: "Edit label rule" });
  await expect(pipeline.getByRole("radio", { name: "Pipeline run" })).toBeChecked();
  await expect(pipeline.getByRole("radio", { name: "Plane" })).toBeChecked();
  await expect(
    pipeline.getByRole("button", { name: "Pipeline", exact: true }),
  ).toContainText("Entwicklungsablauf");
  await expect(pipeline.getByRole("switch", { name: "Paused" })).toBeChecked();
});

test("pause sends paused true and shows Paused", async ({ page, liveStub }) => {
  let current = { rules: [agent] };
  const { ruleCalls } = await ticketsFixture(page, {
    rules: () => current,
    ruleAction: (call) => {
      current = { rules: [{ ...agent, paused: call.body.paused }] };
      return undefined;
    },
  });
  await page.goto(base + "/projects/m1?tab=tickets");
  const card = rulesCard(page);
  await expect(card.getByText("Active", { exact: true })).toBeVisible();
  await ruleMenu(page, "agent").click();
  await page.getByRole("menuitem", { name: "Pause" }).click();
  await expect.poll(() => ruleCalls.length).toBe(1);
  expect(ruleCalls[0]).toEqual({
    method: "PUT",
    path: "/tickets/projects/m1/rules/r1",
    body: {
      source: "github",
      label: "agent",
      kind: "session",
      paused: true,
      allowMerge: false,
      session,
    },
  });
  await liveStub.reread("tickets.rules:m1");
  await expect(card.getByText("Paused", { exact: true })).toBeVisible();
  await ruleMenu(page, "agent").click();
  await expect(page.getByRole("menuitem", { name: "Resume" })).toBeVisible();
});

test("delete asks for confirmation", async ({ page, liveStub }) => {
  let current = { rules: [agent] };
  const { ruleCalls } = await ticketsFixture(page, {
    rules: () => current,
    ruleAction: () => {
      current = { rules: [] };
      return undefined;
    },
  });
  await page.goto(base + "/projects/m1?tab=tickets");
  await ruleMenu(page, "agent").click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("dialog", { name: 'Delete label rule "agent"?' });
  await expect(
    confirm.getByText(/Tickets it already picked up stay in the queue/),
  ).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  expect(ruleCalls).toHaveLength(0);
  await ruleMenu(page, "agent").click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await confirm.getByRole("button", { name: "Delete" }).click();
  await liveStub.reread("tickets.rules:m1");
  await expect(confirm).toHaveCount(0);
  expect(ruleCalls).toEqual([
    { method: "DELETE", path: "/tickets/projects/m1/rules/r1", body: undefined },
  ]);
  await expect(page.getByText(/^No label rules yet\./)).toBeVisible();
});

test("rule error shows on the row", async ({ page }) => {
  await ticketsFixture(page, {
    rules: {
      rules: [
        rule("r1", "agent", { status: { checkedAt: 1, error: { code: "labelGone" } } }),
        rule("r2", "ready", {
          source: "plane",
          status: { checkedAt: 1, error: { code: "unauthorized" } },
        }),
      ],
    },
  });
  await page.goto(base + "/projects/m1?tab=tickets");
  const card = rulesCard(page);
  await expect(card.getByText("Error", { exact: true })).toHaveCount(2);
  await expect(
    card.getByText(
      "Session · 0 tickets picked up · The label does not exist in the ticket source.",
    ),
  ).toBeVisible();
  await expect(
    card.getByText(/The ticket source rejected the credentials\./),
  ).toBeVisible();
});

test("a paused rule shows Paused and keeps its last error", async ({ page }) => {
  await ticketsFixture(page, {
    rules: {
      rules: [
        rule("r1", "agent", {
          paused: true,
          status: { checkedAt: 1, error: { code: "labelGone" } },
        }),
      ],
    },
  });
  await page.goto(base + "/projects/m1?tab=tickets");
  const card = rulesCard(page);
  await expect(card.getByText("Paused", { exact: true })).toBeVisible();
  await expect(card.getByText("Error", { exact: true })).toHaveCount(0);
  await expect(
    card.getByText(
      "Session · 0 tickets picked up · The label does not exist in the ticket source.",
    ),
  ).toBeVisible();
});

test("a failed rules read shows an error with Try again", async ({ page }) => {
  let failing = true;
  await ticketsFixture(page, {
    rules: () =>
      failing ? { status: 500, json: { error: "down" } } : { rules: [agent] },
  });
  await page.goto(base + "/projects/m1?tab=tickets");
  await expect(page.getByText("The label rules could not be loaded.")).toBeVisible();
  // Adding stays possible: the server checks duplicates and the limit itself.
  await expect(page.getByRole("button", { name: "Add label rule" })).toBeVisible();
  failing = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(rulesCard(page).getByText("agent · GitHub")).toBeVisible();
  await expect(page.getByText("The label rules could not be loaded.")).toHaveCount(0);
});

test("a capped pass shows a neutral hint per source", async ({ page }) => {
  const capped = { checkedAt: 1, error: null, capped: true };
  await ticketsFixture(page, {
    rules: {
      rules: [
        rule("r1", "agent", { status: capped }),
        rule("r2", "ready", { source: "plane", status: capped }),
      ],
    },
  });
  await page.goto(base + "/projects/m1?tab=tickets");
  const card = rulesCard(page);
  await expect(
    card.getByText(
      "Session · 0 tickets picked up · Only the newest 300 open issues are checked; older issues with this label are not picked up.",
    ),
  ).toBeVisible();
  await expect(
    card.getByText(/Only 500 work items, closed ones included, are checked/),
  ).toBeVisible();
  // Not an error: both rules stay active.
  await expect(card.getByText("Active", { exact: true })).toHaveCount(2);
  await expect(card.getByText("Error", { exact: true })).toHaveCount(0);
});

test("a live update replaces the list without reload", async ({ page, liveStub }) => {
  let current = { rules: [agent] };
  await ticketsFixture(page, { rules: () => current });
  await page.goto(base + "/projects/m1?tab=tickets");
  const card = rulesCard(page);
  await expect(card.getByText("Session · 3 tickets picked up")).toBeVisible();
  const navigations = [];
  page.on("framenavigated", (frame) => navigations.push(frame.url()));
  current = { rules: [{ ...agent, picked: 4 }, planeRule] };
  await liveStub.reread("tickets.rules:m1");
  await expect(card.getByText("Session · 4 tickets picked up")).toBeVisible();
  await expect(card.getByText("ready · Plane")).toBeVisible();
  expect(navigations).toEqual([]);
});

test("queue item from a rule shows its label", async ({ page }) => {
  const item = (id, key, origin) => ({
    id,
    source: "github",
    key,
    title: "Fix",
    url: "https://github.com/acme/app/issues/1",
    kind: "session",
    origin,
    state: "waiting",
    addedAt: 1000,
    options: { allowMerge: false },
    rounds: { failed: 0 },
  });
  await ticketsFixture(page, {
    rules: { rules: [agent] },
    queue: {
      queue: {
        items: [
          item("i1", "acme/app#7", { kind: "rule", ruleId: "r1" }),
          item("i2", "acme/app#8", { kind: "rule", ruleId: "gone" }),
          item("i3", "acme/app#9", { kind: "manual" }),
        ],
      },
      defaults: { repair: null },
    },
  });
  await page.goto(base + "/projects/m1?tab=tickets");
  const queue = page.getByRole("group", { name: "Queue" });
  await expect(queue.getByText('From label rule "agent"')).toBeVisible();
  await expect(queue.getByText("From a deleted label rule")).toBeVisible();
  await expect(queue.getByText(/From .*label rule/)).toHaveCount(2);
});

test("a rule file of a newer version shows one error and no changes", async ({
  page,
}) => {
  await ticketsFixture(page, {
    rules: { rules: [agent], locked: { code: "unsupportedVersion", version: 2 } },
  });
  await page.goto(base + "/projects/m1?tab=tickets");
  await expect(
    page.getByText(/^Label rules were saved by a newer AgentPier version\./),
  ).toBeVisible();
  await expect(rulesCard(page).getByText("agent · GitHub")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add label rule" })).toHaveCount(0);
  await expect(ruleMenu(page, "agent")).toHaveCount(0);
});
