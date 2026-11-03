import { test, expect } from "../helpers/browser-test.js";
import { baseURL as base } from "../helpers/browser.js";
import { ticketList, ticketsFixture } from "./tickets-fixture.js";

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
    confirm.getByText(/Its session, run, pull request and tracker entry stay/),
  ).toBeVisible();
  await expect(
    confirm.getByRole("button", { name: "Remove", exact: true }),
  ).toBeVisible();
});

test("an unreadable PR asks once more, then sends force", async ({ page }) => {
  const armed = { ...parked, options: { allowMerge: true } };
  const { queueCalls } = await ticketsFixture(page, {
    queue: queueOf(armed),
    queueAction: (call) =>
      call.query === "?force=true"
        ? {
            status: 200,
            json: {
              ...queueOf(),
              unchecked: { key: armed.key, pr: { number: 12, url: armed.pr.url } },
            },
          }
        : {
            status: 409,
            json: {
              error: "GitHub war nicht lesbar.",
              messageKey: "tickets.prUnreadable",
            },
          },
  });
  await page.goto(base + "/projects/m1?tab=tickets");
  await queueMenu(page, "acme/app#7").click();
  await page.getByRole("menuitem", { name: "Aus der Warteschlange entfernen" }).click();
  const confirm = page.getByRole("dialog", {
    name: "acme/app#7 aus der Warteschlange entfernen?",
  });
  await confirm.getByRole("button", { name: "Entfernen", exact: true }).click();
  await expect(confirm.getByText(/Pull Request #12 nicht abschalten/)).toBeVisible();
  await confirm.getByRole("button", { name: "Trotzdem fortfahren" }).click();
  await expect(confirm).toHaveCount(0);
  expect(queueCalls.map((call) => [call.method, call.path, call.query])).toEqual([
    ["DELETE", "/tickets/projects/m1/queue/i1", undefined],
    ["DELETE", "/tickets/projects/m1/queue/i1", "?force=true"],
  ]);
  await expect(
    page.getByText(/acme\/app#7 wurde entfernt\. Prüfe Pull Request #12 auf GitHub/),
  ).toBeVisible();
});

test("a done item shows a failed write-back and an unchecked PR", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await ticketsFixture(page, {
    queue: queueOf(
      item("i7", "AP-7", "Merged", "done", {
        doneBy: "merge",
        pr: { number: 21, url: "https://github.com/acme/app/pull/21" },
        writeBack: { state: "failed", code: "unauthorized" },
      }),
      item("i8", "AP-8", "Forced", "done", {
        doneBy: "owner",
        prUnchecked: true,
        pr: { number: 22, url: "https://github.com/acme/app/pull/22" },
      }),
    ),
  });
  await page.goto(base + "/projects/m1?tab=tickets");
  const card = queueCard(page);
  await expect(
    card.getByText(/^Merged, but not marked done: The ticket source rejected/),
  ).toBeVisible();
  await expect(
    card.getByText(
      "Check pull request #22 on GitHub: auto-merge or the merge queue may still be on.",
    ),
  ).toBeVisible();
});

// "Start as sequence": selection in the ticket list, then the sequence dialog.
const startedView = (body) =>
  queueOf(
    ...body.tickets.map((entry, index) =>
      item(`n${index}`, entry.key, `Ticket ${entry.key}`, index ? "waiting" : "running"),
    ),
  );

async function selectTickets(page, keys, lang = "de") {
  await page
    .getByRole("button", { name: lang === "de" ? "Tickets auswählen" : "Select tickets" })
    .click();
  for (const key of keys)
    await page
      .getByRole("checkbox", {
        name: lang === "de" ? `${key} auswählen` : `Select ${key}`,
        exact: true,
      })
      .check();
}

test("selecting two tickets and starting a session sequence posts both keys in list order with allowMerge false", async ({
  page,
}) => {
  let current = queueOf();
  const { queueCalls } = await ticketsFixture(page, {
    queue: () => current,
    queueAction: (call) => {
      current = startedView(call.body);
      return { status: 201, json: current };
    },
  });
  await page.goto(base + "/projects/m1?tab=tickets");
  await expect(page.getByText("acme/app#7 Fix the login")).toBeVisible();
  // Selected in reverse; the sequence keeps the list order.
  await selectTickets(page, ["AP-3", "acme/app#7"]);
  await page.getByRole("button", { name: "Als Folge starten (2)" }).click();
  const dialog = page.getByRole("dialog", { name: "2 Tickets als Folge starten" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Reihenfolge: acme\/app#7, AP-3\./)).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Session" })).toBeChecked();
  await expect(dialog.getByRole("switch", { name: "Merge erlauben" })).not.toBeChecked();
  await dialog.getByRole("button", { name: "Folge starten" }).click();
  await expect(dialog).toHaveCount(0);
  expect(queueCalls).toHaveLength(1);
  const [{ method, path, body }] = queueCalls;
  expect({ method, path }).toEqual({
    method: "POST",
    path: "/tickets/projects/m1/queue",
  });
  expect(body).toMatchObject({
    tickets: [
      { source: "github", key: "acme/app#7" },
      { source: "plane", key: "AP-3" },
    ],
    kind: "session",
    allowMerge: false,
    again: false,
    session: { tool: "codex", accountId: "local-codex", launchMode: "yolo" },
  });
  expect(body.session.cwd).toBeUndefined();
  expect(body.repair).toBeUndefined();
  // The queue follows the topic; the selection ends.
  await expect(queueCard(page).getByText("acme/app#7 Ticket acme/app#7")).toBeVisible();
  await expect(page.getByRole("button", { name: "Tickets auswählen" })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
});

test("a pipeline sequence sends the repair settings, prefilled from defaults", async ({
  page,
}) => {
  const { queueCalls } = await ticketsFixture(page, {
    queue: {
      queue: { items: [] },
      defaults: {
        repair: {
          tool: "codex",
          accountId: "local-codex",
          nativeModelId: "gpt-5.1",
          launchMode: "default",
        },
      },
    },
    queueAction: (call) => ({ status: 201, json: startedView(call.body) }),
  });
  await page.goto(base + "/projects/m1?tab=tickets");
  await selectTickets(page, ["acme/app#9"]);
  await page.getByRole("button", { name: "Als Folge starten (1)" }).click();
  const dialog = page.getByRole("dialog", { name: "1 Ticket als Folge starten" });
  await dialog.getByRole("radio", { name: "Pipeline-Lauf" }).check();
  // No pipeline chosen yet: the start stays off.
  await expect(dialog.getByRole("button", { name: "Folge starten" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Pipeline", exact: true }).click();
  await page.getByRole("option", { name: "Entwicklungsablauf" }).click();
  const repair = dialog.getByRole("group", { name: "Reparatur-Session" });
  await expect(repair.getByText(/Startet, wenn Checks fehlschlagen/)).toBeVisible();
  await expect(
    repair.getByText(/Vorbelegt mit der neuesten Coding-Session/),
  ).toBeVisible();
  await expect(repair.getByLabel("Natives Modell (optional)")).toHaveValue("gpt-5.1");
  // The repair session takes no sandbox profile.
  await expect(repair.getByText("Sandbox-Profil")).toHaveCount(0);
  await dialog.getByRole("switch", { name: "Merge erlauben" }).check();
  await dialog.getByRole("button", { name: "Folge starten" }).click();
  await expect(dialog).toHaveCount(0);
  expect(queueCalls[0].body).toEqual({
    tickets: [{ source: "github", key: "acme/app#9" }],
    kind: "pipeline",
    allowMerge: true,
    again: false,
    pipeline: { pipelineId: "p1" },
    repair: {
      tool: "codex",
      accountId: "local-codex",
      nativeModelId: "gpt-5.1",
      launchMode: "default",
    },
  });
});

test("repair defaults that arrive after the dialog opened still fill it", async ({
  page,
  liveStub,
}) => {
  let current = queueOf();
  await ticketsFixture(page, { queue: () => current });
  await page.goto(base + "/projects/m1?tab=tickets");
  await selectTickets(page, ["acme/app#9"]);
  await page.getByRole("button", { name: "Als Folge starten (1)" }).click();
  const dialog = page.getByRole("dialog", { name: "1 Ticket als Folge starten" });
  await dialog.getByRole("radio", { name: "Pipeline-Lauf" }).check();
  const repair = dialog.getByRole("group", { name: "Reparatur-Session" });
  await expect(repair.getByLabel("Natives Modell (optional)")).toHaveValue("");
  current = {
    ...queueOf(),
    defaults: {
      repair: {
        tool: "codex",
        accountId: "local-codex",
        nativeModelId: "gpt-5.1",
        launchMode: "default",
      },
    },
  };
  await liveStub.reread("tickets.queue:m1");
  await expect(repair.getByLabel("Natives Modell (optional)")).toHaveValue("gpt-5.1");
  await expect(
    repair.getByText(/Vorbelegt mit der neuesten Coding-Session/),
  ).toBeVisible();
});

test("a selected ticket that a refresh no longer lists is deselected with a notice", async ({
  page,
}) => {
  let list = ticketList;
  await ticketsFixture(page, { list: () => list });
  await page.goto(base + "/projects/m1?tab=tickets");
  await selectTickets(page, ["acme/app#7", "AP-3"]);
  await expect(page.getByRole("button", { name: "Als Folge starten (2)" })).toBeVisible();
  list = {
    ...ticketList,
    tickets: ticketList.tickets.filter((ticket) => ticket.key !== "AP-3"),
  };
  await page.getByRole("button", { name: "Aktualisieren" }).click();
  await expect(
    page.getByText("Nicht mehr in der Liste und daher abgewählt: AP-3."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Als Folge starten (1)" })).toBeVisible();
});

test("already started tickets offer Start again", async ({ page }) => {
  const { queueCalls } = await ticketsFixture(page, {
    queueAction: (call, count) =>
      count === 1
        ? {
            status: 409,
            json: {
              error:
                "Dieses Ticket wurde schon gestartet. Bestätige, um es erneut zu starten.",
              messageKey: "tickets.alreadyStarted",
            },
          }
        : { status: 201, json: startedView(call.body) },
  });
  await page.goto(base + "/projects/m1?tab=tickets");
  await selectTickets(page, ["acme/app#7", "acme/app#9"]);
  await page.getByRole("button", { name: "Als Folge starten (2)" }).click();
  const dialog = page.getByRole("dialog", { name: "2 Tickets als Folge starten" });
  await dialog.getByRole("button", { name: "Folge starten" }).click();
  await expect(dialog.getByText(/wurde schon gestartet/)).toBeVisible();
  await dialog.getByRole("button", { name: "Erneut starten" }).click();
  await expect(dialog).toHaveCount(0);
  expect(queueCalls.map((call) => call.body.again)).toEqual([false, true]);
});

test("in English the selection and the sequence dialog read in English", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await ticketsFixture(page, {});
  await page.goto(base + "/projects/m1?tab=tickets");
  await selectTickets(page, ["acme/app#7", "AP-3"], "en");
  await page.getByRole("button", { name: "Start as sequence (2)" }).click();
  const dialog = page.getByRole("dialog", { name: "Start 2 tickets as a sequence" });
  await expect(
    dialog.getByText(
      "AgentPier works through them one at a time, in this order: acme/app#7, AP-3.",
    ),
  ).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Pipeline run" })).toBeVisible();
  await expect(
    dialog.getByText(/merges each pull request through auto-merge or the merge queue/),
  ).toBeVisible();
  await dialog.getByRole("radio", { name: "Pipeline run" }).check();
  await expect(dialog.getByRole("group", { name: "Repair session" })).toBeVisible();
  await expect(
    dialog.getByText("Starts when checks fail or changes are requested."),
  ).toBeVisible();
  await expect(dialog.getByRole("switch", { name: "Allow merge" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Start sequence" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  // Cancel in the toolbar ends the selection.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
});
