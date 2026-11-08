import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import {
  craftRebuildsFixture,
  readyId,
  rebuild,
  startedId,
  waitingId,
} from "./craft-rebuilds-fixture.js";

// The Rebuilds page: the list, the start form, the owner's defaults and a rebuild's
// detail with its questions, Pause / Continue, follow-up and auto mode.
// AGENTPIER_CRAFT_REBUILDS_SCREENSHOTS names a folder for the docs' screenshots.
const screenshots = process.env.AGENTPIER_CRAFT_REBUILDS_SCREENSHOTS;
const callsTo = (state, suffix, method = "POST") =>
  state.calls.filter((call) => call.method === method && call.path.endsWith(suffix));

test("starts a rebuild from the form and opens it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const state = await craftRebuildsFixture(page);
  await page.goto(`${baseURL}/craft`);
  await expect(page.getByRole("heading", { name: "Rebuilds", level: 1 })).toBeVisible();
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
  await form.getByLabel("Web address of the target").fill("https://todo.example");
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
  expect(callsTo(state, "/craft/settings", "PUT").map((call) => call.body)).toEqual([
    { accountId: "work-claude", mode: "clean-room", autoMode: true },
  ]);
});

test("without Craft Anything the page links to its card and has no start form", async ({
  page,
}) => {
  await craftRebuildsFixture(page, { installed: false, rebuilds: [] });
  await page.goto(`${baseURL}/craft`);
  await expect(page.getByText("Craft Anything is not installed.")).toBeVisible();
  await expect(page.getByText("No rebuilds yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start rebuild" })).toHaveCount(0);
  await page.getByRole("link", { name: "Open Craft Anything" }).click();
  await expect(page).toHaveURL(/\/coding\/clis$/);
});

test("in German the page is called Nachbauten", async ({ page }) => {
  await craftRebuildsFixture(page, { language: "de" });
  await page.goto(`${baseURL}/craft`);
  await expect(page.getByRole("heading", { name: "Nachbauten", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Nachbau starten" })).toBeVisible();
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
  expect(await fits()).toBe(true);
  await page.getByRole("link", { name: /shop-clone/ }).click();
  await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
  expect(await fits()).toBe(true);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/craft$/);
});
