import { test, expect } from "../helpers/browser-test.js";
import { subagentFixture } from "./subagent-fixture.js";

const line = (page) => page.locator(".background-tasks-line");
const sheet = (page, name = "Hintergrundaufgaben") =>
  page.getByRole("dialog", { name, exact: true });
const group = (page, id) => page.locator(`.background-tasks-group[data-group="${id}"]`);
const finishedAgents = (count) =>
  Array.from({ length: count }, (_, index) => ({
    id: `done${index}`,
    name: `Worker ${index}`,
    task: `Finished job ${index}`,
    status: "completed",
    updatedAt: "2026-09-07T09:00:00Z",
  }));

test("the line names running tasks, then open to-dos, then history, and leaves when empty", async ({
  page,
}) => {
  const { data, publish } = await subagentFixture(page);
  await expect(line(page)).toHaveText("1 laufende Aufgabe");
  data.observability.subagents.push({ id: "agentdocs04", status: "running" });
  publish();
  await expect(line(page)).toHaveText("2 laufende Aufgaben");
  for (const agent of data.observability.subagents) agent.status = "completed";
  data.tasks = [
    { id: "one", text: "Parser prüfen", status: "completed" },
    { id: "two", text: "Stile prüfen", status: "pending" },
  ];
  publish();
  await expect(line(page)).toHaveText("Aufgaben 1/2");
  await expect(line(page)).not.toHaveClass(/muted/);
  data.tasks[1].status = "completed";
  publish();
  await expect(line(page)).toHaveText("Hintergrundaufgaben");
  await expect(line(page)).toHaveClass(/muted/);
  data.tasks = [];
  data.observability.subagents = [];
  publish();
  await expect(line(page)).toHaveCount(0);
});

test("the sheet groups running, completed and to-dos and names an agent without details", async ({
  page,
}) => {
  const { data, publish } = await subagentFixture(page);
  data.observability.subagents.push({ id: "agentbare05", status: "running" });
  data.tasks = [
    { id: "one", text: "Parser prüfen", status: "completed" },
    { id: "two", text: "Stile prüfen", status: "in_progress" },
  ];
  publish();
  await expect(line(page)).toHaveText("2 laufende Aufgaben");
  await line(page).click();
  const dialog = sheet(page);
  await expect(dialog).toBeVisible();
  expect(
    await dialog
      .locator(".background-tasks-group")
      .evaluateAll((groups) => groups.map((entry) => entry.dataset.group)),
  ).toEqual(["running", "completed", "todos"]);
  await expect(group(page, "running").locator("summary")).toContainText("Laufend");
  await expect(group(page, "completed").locator("summary")).toContainText(
    "Abgeschlossen 1",
  );
  await expect(group(page, "todos").locator("summary")).toContainText("To-dos 1/2");
  const running = group(page, "running").locator(".subagent-entry");
  await expect(running).toHaveCount(2);
  await expect(running.nth(0)).toContainText("Check styles");
  await expect(running.nth(0)).toContainText("Agent");
  await expect(running.nth(1)).toContainText("agentbare05");
  await expect(running.nth(1)).toContainText("Keine Aufgabenbeschreibung gemeldet.");
  const done = group(page, "completed").locator(".subagent-entry");
  await expect(done).toContainText("Review parser");
  await expect(done.locator(".subagent-status")).toHaveText("Erledigt");
  await expect(dialog.getByLabel("Aufgabenfortschritt")).toHaveAttribute("value", "1");
  await expect(group(page, "todos")).toContainText("Stile prüfen");
  await expect(group(page, "todos")).toContainText("In Arbeit");
});

test("a long history starts collapsed and scrolls inside the sheet", async ({ page }) => {
  const { data, publish } = await subagentFixture(page);
  data.observability.subagents.push(...finishedAgents(100));
  publish();
  await line(page).click();
  const dialog = sheet(page);
  const completed = group(page, "completed");
  await expect(completed.locator("summary")).toContainText("Abgeschlossen 101");
  await expect(completed).not.toHaveAttribute("open", "");
  await expect(group(page, "running")).toHaveAttribute("open", "");
  await completed.locator("summary").click();
  await expect(completed.locator(".subagent-entry")).toHaveCount(101);
  const box = await dialog.boundingBox(),
    view = page.viewportSize();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  expect(
    await dialog.evaluate((element) => element.scrollHeight > element.clientHeight),
  ).toBe(true);
});

test("an agent that finishes while the sheet is open moves to Completed", async ({
  page,
}) => {
  const { data, publish } = await subagentFixture(page);
  await line(page).click();
  const dialog = sheet(page);
  await expect(group(page, "running").locator(".subagent-entry")).toHaveCount(1);
  data.observability.subagents[1].status = "completed";
  publish();
  await expect(group(page, "running")).toHaveCount(0);
  await expect(group(page, "completed").locator(".subagent-entry")).toHaveCount(2);
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate((element) => element.contains(document.activeElement)),
  ).toBe(true);
  // The line behind the sheet follows as well.
  await page.keyboard.press("Escape");
  await expect(line(page)).toHaveText("Hintergrundaufgaben");
});

test("the appearing line keeps a chat that follows the bottom pinned", async ({
  page,
}) => {
  const { data, publish } = await subagentFixture(page);
  data.observability.subagents = [];
  data.messages.push({
    id: "long",
    role: "assistant",
    text: Array.from({ length: 80 }, (_, index) => `Zeile ${index}`).join("\n\n"),
  });
  publish();
  await expect(line(page)).toHaveCount(0);
  const messages = page.locator(".chat-messages");
  const gap = () =>
    messages.evaluate(
      (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
    );
  await expect(messages).toContainText("Zeile 79");
  await expect.poll(gap).toBeLessThan(2);
  data.observability.subagents = [{ id: "agentnew06", status: "running" }];
  publish();
  await expect(line(page)).toHaveText("1 laufende Aufgabe");
  await expect.poll(gap).toBeLessThan(2);
});

test("Escape returns focus to the opener, from the line and from the header", async ({
  page,
}) => {
  await subagentFixture(page);
  await line(page).click();
  await expect(sheet(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
  await expect(line(page)).toBeFocused();
  const header = page.getByRole("button", { name: "Unteragenten anzeigen" });
  await header.click();
  await expect(sheet(page)).toBeVisible();
  await page.getByRole("button", { name: "Dialog schließen" }).click();
  await expect(sheet(page)).toBeHidden();
  await expect(header).toBeFocused();
});

test("on a phone the sheet rises from the bottom over the full width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await subagentFixture(page);
  const before = await page.locator(".chat-messages").boundingBox();
  await line(page).click();
  const dialog = sheet(page);
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box.width).toBe(390);
  expect(Math.round(box.y + box.height)).toBe(844);
  expect((await page.locator(".chat-messages").boundingBox()).height).toBe(before.height);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test.describe("English", () => {
  test.use({ locale: "en-GB" });
  test("line and sheet are translated", async ({ page }) => {
    const { data, publish } = await subagentFixture(page);
    await expect(line(page)).toHaveText("1 running task");
    data.observability.subagents.push({ id: "agentdocs04", status: "running" });
    data.tasks = [{ id: "one", text: "Check the parser", status: "pending" }];
    publish();
    await expect(line(page)).toHaveText("2 running tasks");
    await line(page).click();
    await expect(sheet(page, "Background tasks")).toBeVisible();
    await expect(group(page, "running").locator("summary")).toContainText("Running");
    await expect(group(page, "completed").locator("summary")).toContainText(
      "Completed 1",
    );
    await expect(group(page, "todos").locator("summary")).toContainText("To-dos 0/1");
    await page.keyboard.press("Escape");
    for (const agent of data.observability.subagents) agent.status = "completed";
    publish();
    await expect(line(page)).toHaveText("Tasks 0/1");
  });
});
