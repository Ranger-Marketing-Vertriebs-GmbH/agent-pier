import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import {
  buildingId,
  craftRebuildsFixture,
  readyId,
  rebuild,
  startedId,
  waitingId,
} from "./craft-rebuilds-fixture.js";

// The Craft Anything page: the list, the start form, the owner's defaults and a rebuild's
// detail with its questions, Pause / Continue, follow-up and auto mode.
// AGENTPIER_CRAFT_REBUILDS_SCREENSHOTS names a folder for the docs' screenshots.
const screenshots = process.env.AGENTPIER_CRAFT_REBUILDS_SCREENSHOTS;
const callsTo = (state, suffix, method = "POST") =>
  state.calls.filter((call) => call.method === method && call.path.endsWith(suffix));

test("starts a rebuild from the form and opens it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const state = await craftRebuildsFixture(page);
  await page.goto(`${baseURL}/craft`);
  await expect(
    page.getByRole("heading", { name: "Craft Anything", level: 1 }),
  ).toBeVisible();
  const list = page.getByRole("group", { name: "Your rebuilds" });
  await expect(list.getByRole("link")).toHaveCount(3);
  await expect(list.getByRole("link").first()).toContainText("shop-clone");
  await expect(list.getByRole("link").first()).toContainText("Needs you");
  await expect(list.getByRole("link", { name: /notes-app/ })).toContainText("Building");
  if (screenshots)
    await page.screenshot({
      path: `${screenshots}/craft-rebuilds-list.png`,
      fullPage: true,
    });

  await page.getByLabel("What to make").fill("A to-do app like the target");
  const form = page.getByRole("group", { name: "Start a rebuild" });
  await form.getByRole("radio", { name: "Web address" }).check();
  const name = form.getByLabel("Project name");
  // A short name from the request, then from the target, never the request itself.
  await expect(name).toHaveValue("to-do-app");
  await form.getByLabel("Web address of the target").fill("https://todo.example");
  await expect(name).toHaveValue("todo-example");
  await form.getByRole("combobox", { name: "Stack" }).selectOption("Plain HTML and CSS");
  await form
    .getByRole("combobox", { name: "Claude account" })
    .selectOption("work-claude");
  await form.getByRole("radio", { name: "Deep" }).check();
  await form.getByRole("switch", { name: "Auto mode" }).check();
  await expect(page.getByText(/never bypass DRM/)).toBeVisible();
  await page.getByRole("button", { name: "Start rebuild" }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/craft/${startedId}$`));
  const starts = callsTo(state, "/craft/rebuilds");
  expect(starts.length).toBeGreaterThanOrEqual(1);
  // A double click resends the same key, so it starts once.
  expect(new Set(starts.map((call) => call.body.requestId)).size).toBe(1);
  expect(starts[0].body).toEqual({
    request: "A to-do app like the target",
    name: "todo-example",
    target: "https://todo.example",
    stack: "Plain HTML and CSS",
    accountId: "work-claude",
    mode: "deep",
    autoMode: true,
    rounds: 2,
    requestId: expect.any(String),
  });
  expect(state.rebuilds.filter((item) => item.id === startedId)).toHaveLength(1);
  await expect(page.getByRole("heading", { name: "todo-app", level: 1 })).toBeVisible();
});

test("the project name must be short and given when none can be derived", async ({
  page,
}) => {
  const state = await craftRebuildsFixture(page);
  await page.goto(`${baseURL}/craft`);
  const form = page.getByRole("group", { name: "Start a rebuild" });
  const name = form.getByLabel("Project name");
  const prompt = "Eine App die das gleiche kann wie die Adresse jedes Feature";
  await page.getByLabel("What to make").fill(prompt);
  await expect(name).toHaveValue("app-adresse-feature");
  await name.fill(prompt);
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(form.getByText(/Shorten the project name/)).toBeVisible();
  await page.getByRole("button", { name: "Start rebuild" }).click();
  await expect(page.getByText(/Give the project a short name/)).toBeVisible();
  // Nothing sensible to derive: the field stays empty and required.
  await name.fill("");
  await page.getByLabel("What to make").fill("Rebuild");
  await expect(name).toHaveValue("");
  await page.getByRole("button", { name: "Start rebuild" }).click();
  expect(callsTo(state, "/craft/rebuilds")).toHaveLength(0);
  await name.fill("adressen-app");
  await page.getByRole("button", { name: "Start rebuild" }).click();
  await expect.poll(() => callsTo(state, "/craft/rebuilds").length).toBe(1);
  expect(callsTo(state, "/craft/rebuilds")[0].body).toMatchObject({
    request: "Rebuild",
    name: "adressen-app",
  });
});

test("answers a question and allows an approval on the rebuild's page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1400 });
  const state = await craftRebuildsFixture(page);
  await page.goto(`${baseURL}/craft`);
  await page.getByRole("link", { name: /shop-clone/ }).click();
  await expect(page).toHaveURL(new RegExp(`/craft/${waitingId}$`));
  const steps = page.getByRole("list", { name: "Steps" });
  await expect(steps.getByRole("listitem")).toHaveText([
    "Study",
    "Build",
    "Check",
    "Ready",
  ]);
  await expect(steps.locator('[aria-current="step"]')).toHaveText("Build");
  await expect(page.getByText("Building the cart page", { exact: true })).toBeVisible();
  await expect(
    page.getByText("build: passed · 72 % similar to the target"),
  ).toBeVisible();
  await expect(page.getByText("About $1.87")).toBeVisible();
  await expect(page.getByText("The product list and the header are done.")).toBeVisible();
  await expect(page.locator(".craft-activity")).toContainText("Captured 6 pages");
  await expect(page.getByRole("link", { name: "Open project" })).toHaveAttribute(
    "href",
    "/projects/shop-clone",
  );
  await expect(page.getByRole("link", { name: "Open folder" })).toHaveAttribute(
    "href",
    `/files?path=${encodeURIComponent("/fixture/projects/shop-clone/app")}`,
  );
  if (screenshots)
    await page.screenshot({
      path: `${screenshots}/craft-rebuilds-detail.png`,
      fullPage: true,
    });

  await page
    .getByRole("group", { name: "Answers" })
    .getByRole("button", { name: "Dark blue" })
    .click();
  await expect(page.getByText("Which colour should the buttons have?")).toHaveCount(0);
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(page.getByText("Install the dependencies?")).toHaveCount(0);
  expect(callsTo(state, "/answer").map((call) => call.body)).toEqual([
    { questionId: "q1", choice: "Dark blue" },
    { questionId: "q2", allow: true },
  ]);
  await expect(page.getByRole("heading", { name: "Waiting for you" })).toHaveCount(0);
});

test("pauses and continues a rebuild and switches its auto mode", async ({ page }) => {
  const state = await craftRebuildsFixture(page);
  await page.goto(`${baseURL}/craft/${waitingId}`);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  // Paused: the follow-up box shows, Continue resumes.
  await expect(page.getByRole("heading", { name: "Ask for changes" })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  expect(callsTo(state, "/pause")).toHaveLength(1);
  expect(callsTo(state, "/continue")).toHaveLength(1);
  const auto = page.getByRole("switch", { name: "Auto mode" });
  await expect(auto).not.toBeChecked();
  await auto.check();
  await expect(auto).toBeChecked();
  expect(callsTo(state, "/auto-mode").map((call) => call.body)).toEqual([{ on: true }]);
});

test("the activity follows the rebuild's pushes and keeps its lines when a read fails", async ({
  page,
  liveStub,
}) => {
  const state = await craftRebuildsFixture(page);
  const topic = `craft.rebuild:${buildingId}`;
  await page.goto(`${baseURL}/craft/${buildingId}`);
  const activity = page.locator(".craft-activity");
  await expect(activity).toContainText("Working on: Studying the target");
  // A new line changes the rebuild's activity revision: the page reads it again.
  state.activity = ["Reading the target", "Captured 7 pages"];
  Object.assign(
    state.rebuilds.find((item) => item.id === buildingId),
    {
      activityRevision: "b",
    },
  );
  await liveStub.reread(topic);
  await expect(activity).toContainText("Captured 7 pages");
  state.activityFails = true;
  Object.assign(
    state.rebuilds.find((item) => item.id === buildingId),
    {
      activityRevision: "c",
    },
  );
  await liveStub.reread(topic);
  await expect(page.getByText("Craft Anything did not answer.")).toBeVisible();
  await expect(activity).toContainText("Captured 7 pages");
});

test("an approval auto mode could not allow carries a note", async ({ page }) => {
  const state = await craftRebuildsFixture(page);
  const waiting = state.rebuilds.find((item) => item.id === waitingId);
  waiting.autoMode = true;
  waiting.questions[1].autoFailed = true;
  await page.goto(`${baseURL}/craft/${waitingId}`);
  const card = page.getByRole("article", { name: "Install the dependencies?" });
  await expect(card.getByRole("note")).toHaveText(
    "Auto mode could not allow this. Decide here whether it may run.",
  );
  await expect(
    page
      .getByRole("article", { name: "Which colour should the buttons have?" })
      .getByRole("note"),
  ).toHaveCount(0);
});

test("removes a rebuild from the list after a confirmation", async ({
  page,
  liveStub,
}) => {
  const state = await craftRebuildsFixture(page);
  await page.goto(`${baseURL}/craft/${buildingId}`);
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  // A running rebuild is paused first.
  await expect(page.getByRole("button", { name: "Remove from list" })).toHaveCount(0);
  await page.goto(`${baseURL}/craft/${readyId}`);
  await page.getByRole("button", { name: "Remove from list" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Remove rebuild “timer” from the list?",
  });
  await expect(dialog).toContainText("Its folder and its project stay");
  if (screenshots)
    await page.screenshot({ path: `${screenshots}/craft-rebuilds-remove.png` });
  await dialog.getByRole("button", { name: "Remove from list" }).click();
  await expect(page).toHaveURL(`${baseURL}/craft`);
  await expect(page.getByRole("link", { name: /shop-clone/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /timer/ })).toHaveCount(0);
  expect(callsTo(state, `/craft/rebuilds/${readyId}`, "DELETE")).toHaveLength(1);
  // The server's topic reads a removed rebuild as null (the stub's REST read is 404).
  await page.goto(`${baseURL}/craft/${readyId}`);
  await liveStub.waitForSubscribe(`craft.rebuild:${readyId}`);
  await liveStub.push(`craft.rebuild:${readyId}`, { rebuild: null });
  await expect(page.getByText("This rebuild no longer exists.")).toBeVisible();
});

test("asks a ready rebuild for changes", async ({ page }) => {
  const state = await craftRebuildsFixture(page);
  await page.goto(`${baseURL}/craft/${readyId}`);
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(
    0,
  );
  await page
    .getByLabel("Starts another round in the same project.")
    .fill("Add a dark theme");
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(page.getByText("Building", { exact: true })).toBeVisible();
  expect(callsTo(state, "/follow-up").map((call) => call.body)).toEqual([
    { request: "Add a dark theme" },
  ]);
});

test("a rebuild that never reached Craft Anything offers no Continue or changes", async ({
  page,
}) => {
  const state = await craftRebuildsFixture(page);
  const id = "f0f0f0f0-1111-4222-8333-444455556666";
  state.rebuilds.push(
    rebuild({
      id,
      started: false,
      name: "lost-start",
      request: "A start that never reached Craft Anything",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "failed",
      step: "study",
    }),
  );
  await page.goto(`${baseURL}/craft/${id}`);
  await expect(page.getByText("Failed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("heading", { name: "Ask for changes" })).toHaveCount(0);
});

test("saves the owner's defaults", async ({ page }) => {
  const state = await craftRebuildsFixture(page);
  await page.goto(`${baseURL}/craft`);
  const save = page.getByRole("button", { name: "Save defaults" });
  await expect(save).toBeDisabled();
  const defaults = page.getByRole("group", { name: "Defaults" });
  await defaults
    .getByRole("combobox", { name: "Claude account" })
    .selectOption("work-claude");
  await defaults.getByRole("switch", { name: "Auto mode" }).check();
  await save.click();
  await expect(save).toBeDisabled();
  await expect(
    page.getByRole("status").filter({ hasText: "Defaults saved." }),
  ).toBeVisible();
  expect(callsTo(state, "/craft/settings", "PUT").map((call) => call.body)).toEqual([
    { accountId: "work-claude", mode: "clean-room", autoMode: true },
  ]);
  // The start form on the same page takes the saved defaults.
  const form = page.locator("form.craft-start");
  await expect(form.getByRole("combobox", { name: "Claude account" })).toHaveValue(
    "work-claude",
  );
  await expect(form.getByRole("switch", { name: "Auto mode" })).toBeChecked();
});

test("the start form names stacks and the local account in the page's language", async ({
  page,
}) => {
  await craftRebuildsFixture(page);
  await page.goto(`${baseURL}/craft`);
  const form = page.locator("form.craft-start");
  const account = form.getByRole("combobox", { name: "Claude account" });
  await expect(account.locator("option", { hasText: "Claude Code · Local" })).toHaveCount(
    1,
  );
  const stack = form.getByRole("combobox", { name: "Stack" });
  await expect(stack.locator("option", { hasText: "Unity" })).toHaveAttribute(
    "value",
    "unity",
  );
});

test("without Craft Anything the page links to its card and has no start form", async ({
  page,
}) => {
  await craftRebuildsFixture(page, { installed: false, rebuilds: [] });
  await page.goto(`${baseURL}/craft`);
  await expect(page.getByText("Craft Anything is not installed.")).toBeVisible();
  await expect(page.getByText("No rebuilds yet.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start rebuild" })).toHaveCount(0);
  // The install dialog opens here; the link still leads to the card.
  await page.getByRole("link", { name: "Open Craft Anything" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page).toHaveURL(/\/craft$/);
});

test("in German the page is called Craft Anything and its actions say Nachbau", async ({
  page,
}) => {
  await craftRebuildsFixture(page, { language: "de" });
  await page.goto(`${baseURL}/craft`);
  await expect(
    page.getByRole("heading", { name: "Craft Anything", level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Nachbau starten" })).toBeVisible();
  const stack = page.locator("form.craft-start").getByRole("combobox", { name: "Stack" });
  await expect(stack.locator("option", { hasText: "Wahl des Builders" })).toHaveCount(1);
  await expect(
    page.locator("form.craft-start").getByRole("combobox", { name: "Claude-Account" }),
  ).toContainText("Claude Code · Lokal");
});

test("on a phone the list and the detail fit the width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await craftRebuildsFixture(page);
  const fits = () =>
    page.evaluate(
      () => document.scrollingElement.scrollWidth <= document.documentElement.clientWidth,
    );
  await page.goto(`${baseURL}/craft`);
  await expect(page.getByRole("link", { name: /shop-clone/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start rebuild" })).toBeVisible();
  // The page header carries the one menu button; the app's phone header steps aside.
  await expect(page.getByRole("button", { name: "Open navigation" })).toHaveCount(1);
  await expect(page.locator(".mobile-header")).toBeHidden();
  expect(await fits()).toBe(true);
  await page.getByRole("link", { name: /shop-clone/ }).click();
  await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
  await expect(page.locator(".mobile-header")).toBeHidden();
  expect(await fits()).toBe(true);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/craft$/);
});
