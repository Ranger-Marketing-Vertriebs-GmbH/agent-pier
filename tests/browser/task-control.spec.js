import { test, expect } from "../helpers/browser-test.js";
import { subagentFixture } from "./subagent-fixture.js";

const line = (page) => page.locator(".background-tasks-line");
const sheet = (page, name = "Hintergrundaufgaben") =>
  page.getByRole("dialog", { name, exact: true });
const group = (page, id) => page.locator(`.background-tasks-group[data-group="${id}"]`);
const card = (page, id) => page.locator(`.subagent-entry[data-task-id="${id}"]`);
const note = {
  id: "n1",
  text: '[AgentPier: the user stopped background task "Explore" (agentstyles02).]',
};
const shell = (overrides = {}) => ({
  id: "bash01",
  command: "sleep 300",
  status: "running",
  updatedAt: "2026-09-07T10:00:05Z",
  canStop: true,
  hasOutput: true,
  ...overrides,
});
const refused = {
  code: "TASK_STOP_REFUSED",
  reason: "Task is not interruptible",
  error: "Die CLI hat das Beenden der Aufgabe abgelehnt.",
  messageKey: "chat.taskStopRefused",
};
const notRunning = {
  code: "TASK_STOP_NOT_RUNNING",
  error: "Diese Aufgabe läuft nicht mehr.",
  messageKey: "chat.taskStopNotRunning",
};

/** Answers the task routes from `answers` and records every request. */
async function taskRoutes(page, answers = {}) {
  const requests = [];
  await page.route("**/api/sessions/subagents/tasks/**", async (route) => {
    const url = new URL(route.request().url());
    const [, taskId, action] = url.pathname.match(/\/tasks\/([^/]+)\/([^/]+)$/);
    const id = decodeURIComponent(taskId);
    requests.push({ id, action, method: route.request().method() });
    const answer = await answers[action]?.(id);
    if (answer?.status)
      return route.fulfill({ status: answer.status, json: answer.json });
    return route.fulfill({ json: answer ?? {} });
  });
  await page.route("**/api/sessions/subagents/chat/slash-commands", (route) =>
    route.fulfill({ json: { commands: [] } }),
  );
  return requests;
}

/**
 * Records every message body and answers with the next status of `outcomes`
 * (handed off once they run out). "absent" drops the request, as when the network
 * fails before the server saw it.
 */
async function inputRoute(page, outcomes = []) {
  const posts = [];
  const receipts = new Map();
  await page.route("**/api/sessions/subagents/input**", (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      posts.push(body);
      const status = outcomes.shift() || "handed-off";
      receipts.set(body.deliveryId, { deliveryId: body.deliveryId, status });
      if (status === "absent") return route.abort();
      return route.fulfill({ json: receipts.get(body.deliveryId) });
    }
    const id = new URL(request.url()).pathname.split("/").pop();
    return route.fulfill({
      json: receipts.get(id) || { deliveryId: id, status: "absent" },
    });
  });
  return posts;
}

test("a shell counts in the line and shows its kind and command", async ({ page }) => {
  const { data, publish } = await subagentFixture(page);
  await taskRoutes(page);
  data.observability.shells = [
    shell(),
    shell({
      id: "bash02",
      command: "npm run build",
      description: "Build the app",
      status: "completed",
      canStop: false,
    }),
  ];
  publish();
  await expect(line(page)).toHaveText("2 laufende Aufgaben");
  await line(page).click();
  const running = card(page, "bash01");
  await expect(running).toContainText("Shell");
  await expect(running.locator(".task-command")).toHaveText("sleep 300");
  await expect(running.getByRole("button", { name: "Ausgabe anzeigen" })).toBeVisible();
  await expect(card(page, "agentstyles02")).toContainText("Agent");
  const described = card(page, "bash02");
  await expect(described.locator("strong")).toHaveText("Build the app");
  await expect(described.locator(".task-command")).toHaveText("npm run build");
  await expect(described.getByRole("button", { name: "Aufgabe stoppen" })).toHaveCount(0);
});

test("a finished shell shows its exit code and a child's shell the agent that owns it", async ({
  page,
}) => {
  const { data, publish } = await subagentFixture(page);
  await taskRoutes(page);
  data.observability.shells = [
    shell({ id: "c:1", command: "npm test", ownerAgentId: "agentstyles02" }),
    shell({ id: "c:2", command: "make", ownerAgentId: "thread-gone" }),
    shell({ id: "b2", command: "false", status: "failed", exitCode: 2, canStop: false }),
    shell({
      id: "b3",
      command: "true",
      status: "completed",
      exitCode: 0,
      canStop: false,
    }),
    shell({
      id: "b4",
      command: "sleep 9",
      status: "stopped",
      exitCode: -1,
      canStop: false,
    }),
  ];
  publish();
  await line(page).click();
  await expect(card(page, "c:1").locator(".task-owner")).toHaveText("Von Explore");
  await expect(card(page, "c:2").locator(".task-owner")).toHaveText("Von thread-gone");
  await expect(card(page, "c:1").locator(".task-exit")).toHaveCount(0);
  await expect(card(page, "b2").locator(".task-exit")).toHaveText("Exit-Code 2");
  await expect(card(page, "b3").locator(".task-exit")).toHaveText("Exit-Code 0");
  await expect(card(page, "b4").locator(".task-exit")).toHaveCount(0);
  await expect(card(page, "b2").locator(".task-owner")).toHaveCount(0);
});

test("the transcript opens in the sheet, reloads only on change, and back keeps the place", async ({
  page,
}) => {
  const { data, publish } = await subagentFixture(page);
  data.observability.subagents.push(
    ...Array.from({ length: 30 }, (_, index) => ({
      id: `done${index}`,
      name: `Worker ${index}`,
      task: `Finished job ${index}`,
      status: "completed",
      updatedAt: "2026-09-07T09:00:00Z",
      hasTranscript: true,
    })),
  );
  const requests = await taskRoutes(page, {
    transcript: () => ({
      messages: Array.from({ length: 50 }, (_, index) => ({
        id: `m${index}`,
        role: "assistant",
        text: index === 49 ? "The styles look consistent." : `Step ${index}`,
      })),
      partial: true,
      truncated: true,
    }),
  });
  publish();
  await line(page).click();
  const dialog = sheet(page);
  await group(page, "completed").locator("summary").click();
  const target = card(page, "done25");
  await target.scrollIntoViewIfNeeded();
  const before = await dialog.evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(0);
  await target.getByRole("button", { name: "Verlauf anzeigen" }).click();
  const detail = dialog.locator(".background-task-detail");
  await expect(detail).toContainText("The styles look consistent.");
  await expect(detail).toContainText("Worker 25");
  await expect(detail).toContainText("Zeigt die letzten 50 Nachrichten.");
  await expect(detail).toContainText("Die Aufgabe läuft noch");
  await expect(target).toBeHidden();
  await page.clock.runFor(3000);
  expect(requests.filter((entry) => entry.action === "transcript")).toHaveLength(1);
  // A change of this entry in the chat frame reloads; another entry's does not.
  data.observability.subagents[1].updatedAt = "2026-09-07T10:00:09Z";
  publish();
  await page.clock.runFor(1000);
  expect(requests.filter((entry) => entry.action === "transcript")).toHaveLength(1);
  data.observability.subagents.find((entry) => entry.id === "done25").updatedAt =
    "2026-09-07T10:00:09Z";
  publish();
  await expect
    .poll(() => requests.filter((entry) => entry.action === "transcript").length)
    .toBe(2);
  await dialog.getByRole("button", { name: "Zurück zur Liste" }).click();
  await expect(target).toBeVisible();
  await expect(group(page, "completed")).toHaveAttribute("open", "");
  expect(await dialog.evaluate((element) => element.scrollTop)).toBe(before);
  await expect(target.getByRole("button", { name: "Verlauf anzeigen" })).toBeFocused();
});

test("shell output shows its tail, refreshes on demand and says when it is gone", async ({
  page,
}) => {
  const { data, publish } = await subagentFixture(page);
  let gone = false;
  const requests = await taskRoutes(page, {
    output: () =>
      gone
        ? { text: "", truncated: false, gone: true }
        : { text: "tick 1\ntick 2", truncated: false, gone: false },
  });
  data.observability.shells = [shell({ id: "thread:7" })];
  publish();
  await line(page).click();
  await card(page, "thread:7").getByRole("button", { name: "Ausgabe anzeigen" }).click();
  const detail = sheet(page).locator(".background-task-detail");
  await expect(detail.locator("pre")).toHaveText("tick 1\ntick 2");
  expect(requests).toEqual([{ id: "thread:7", action: "output", method: "GET" }]);
  gone = true;
  await detail.getByRole("button", { name: "Aktualisieren" }).click();
  await expect(detail).toContainText("Die Ausgabe ist nicht mehr vorhanden.");
  expect(requests).toHaveLength(2);
});

test("stop is busy, then the card moves to Completed; refusals show on the card", async ({
  page,
}) => {
  const { data, publish } = await subagentFixture(page);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await taskRoutes(page, {
    stop: async (id) => {
      if (id === "agentstyles02") {
        await held;
        return { stopped: true };
      }
      if (id === "bash01") return { status: 409, json: notRunning };
      return { status: 409, json: refused };
    },
  });
  data.observability.subagents.push({
    id: "agentdocs04",
    name: "Docs",
    task: "Write docs",
    status: "running",
    canStop: true,
  });
  data.observability.shells = [shell()];
  publish();
  await line(page).click();
  const target = card(page, "agentstyles02");
  const stop = target.getByRole("button", { name: "Aufgabe stoppen" });
  await stop.click();
  await expect(stop).toHaveAttribute("aria-busy", "true");
  await expect(stop).toBeDisabled();
  release();
  data.observability.subagents[1].status = "stopped";
  data.observability.subagents[1].canStop = false;
  publish();
  const stopped = group(page, "completed").locator('[data-task-id="agentstyles02"]');
  await expect(stopped.locator(".subagent-status")).toHaveText("Gestoppt");
  await expect(stopped.getByRole("button", { name: "Aufgabe stoppen" })).toHaveCount(0);

  const docs = card(page, "agentdocs04");
  await docs.getByRole("button", { name: "Aufgabe stoppen" }).click();
  await expect(docs.getByRole("alert")).toHaveText(
    "Die CLI hat das Beenden der Aufgabe abgelehnt. (Task is not interruptible)",
  );
  await expect(docs.getByRole("button", { name: "Aufgabe stoppen" })).toBeEnabled();

  // The shell ended by itself a moment earlier: a message, then the next frame moves it.
  const bash = card(page, "bash01");
  await bash.getByRole("button", { name: "Aufgabe stoppen" }).click();
  await expect(bash.getByRole("alert")).toHaveText("Diese Aufgabe läuft nicht mehr.");
  data.observability.shells[0] = shell({ status: "completed", canStop: false });
  publish();
  await expect(group(page, "completed").locator('[data-task-id="bash01"]')).toHaveCount(
    1,
  );
  await expect(sheet(page)).toBeVisible();
  await expect(
    card(page, "agentreview01").getByRole("button", { name: "Aufgabe stoppen" }),
  ).toHaveCount(0);
});

test("the composer appends pending stop notes once and never to commands", async ({
  page,
}) => {
  const { data, publish } = await subagentFixture(page);
  await taskRoutes(page);
  const posts = await inputRoute(page);
  data.observability.stopNotes = [note];
  publish();
  const composer = page.locator(".chat-composer textarea");
  const send = page.getByRole("button", { name: "Senden", exact: true });
  await composer.fill("weiter");
  await send.click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0].text).toBe(`weiter\n\n${note.text}`);
  expect(posts[0].stopNoteIds).toEqual(["n1"]);
  await expect(composer).toHaveValue("");
  // The first message is handed off but not yet accepted: the note is not repeated.
  await composer.fill("noch etwas");
  await send.click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1].text).toBe("noch etwas");
  expect(posts[1].stopNoteIds).toBeUndefined();
  await expect(composer).toHaveValue("");
  await composer.fill("/compact");
  await send.click();
  await expect.poll(() => posts.length).toBe(3);
  expect(posts[2].text).toBe("/compact");
  expect(posts[2].stopNoteIds).toBeUndefined();
});

test("a note goes again with the resend of an absent or rejected message, once", async ({
  page,
}) => {
  const { data, publish } = await subagentFixture(page);
  await taskRoutes(page);
  const posts = await inputRoute(page, ["absent", "rejected", "handed-off"]);
  data.observability.stopNotes = [note];
  publish();
  const composer = page.locator(".chat-composer textarea");
  const send = page.getByRole("button", { name: "Senden", exact: true });
  const carried = `weiter\n\n${note.text}`;
  await composer.fill("weiter");
  await send.click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ text: carried, stopNoteIds: ["n1"] });
  // Never reached the server: taken back into the composer and sent again.
  await page.getByRole("button", { name: "Nachricht bearbeiten" }).click();
  await expect(composer).toHaveValue("weiter");
  await send.click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toMatchObject({ text: carried, stopNoteIds: ["n1"] });
  // Rejected: the composer keeps the text, and the next send carries the note again.
  await expect(composer).toHaveValue("weiter");
  await send.click();
  await expect.poll(() => posts.length).toBe(3);
  expect(posts[2]).toMatchObject({ text: carried, stopNoteIds: ["n1"] });
  await expect(composer).toHaveValue("");
  // Handed off and not yet accepted: the note is not repeated.
  await composer.fill("danach");
  await send.click();
  await expect.poll(() => posts.length).toBe(4);
  expect(posts[3].text).toBe("danach");
  expect(posts[3].stopNoteIds).toBeUndefined();
});

test("a transcript names the main agent's prompt and never loads rows from the main chat", async ({
  page,
}) => {
  const { publish } = await subagentFixture(page);
  const loads = [];
  page.on("request", (request) => {
    if (request.url().includes("/chat/messages/")) loads.push(request.url());
  });
  await taskRoutes(page, {
    transcript: () => ({
      messages: [
        { id: "claude:0", role: "user", text: "Check the stylesheet." },
        {
          id: "claude:1",
          role: "tool",
          toolName: "Bash",
          status: "completed",
          text: "first lines",
          textTail: "last lines",
          truncated: { length: 40000, bytes: 40000 },
        },
        { id: "claude:2", role: "assistant", text: "Done." },
      ],
      partial: false,
      truncated: false,
    }),
  });
  publish();
  await line(page).click();
  await card(page, "agentstyles02")
    .getByRole("button", { name: "Verlauf anzeigen" })
    .click();
  const detail = sheet(page).locator(".background-task-detail");
  await expect(detail).toContainText("Done.");
  await expect(detail.locator(".chat-message.user")).toHaveCount(0);
  await expect(
    detail.getByRole("region", { name: "Auftrag vom Hauptagenten" }),
  ).toContainText("Check the stylesheet.");
  await detail.locator(".chat-tool-group .activity-row-head").click();
  await detail.locator(".chat-tool > summary").click();
  await expect(detail.locator(".tool-output-omitted")).toBeVisible();
  await expect(detail).toContainText("last lines");
  await expect(detail.locator(".tool-output-truncated button")).toHaveCount(0);
  await page.clock.runFor(1000);
  expect(loads).toEqual([]);
});

test("a stopped task whose frame keeps it listed frees its stop button", async ({
  page,
}) => {
  const { data, publish } = await subagentFixture(page);
  await taskRoutes(page, { stop: () => ({ stopped: true }) });
  await line(page).click();
  const target = card(page, "agentstyles02");
  const stop = target.getByRole("button", { name: "Aufgabe stoppen" });
  await stop.click();
  await expect(stop).toBeDisabled();
  data.observability.subagents[1].canStop = false;
  publish();
  await expect(stop).toHaveCount(0);
  data.observability.subagents[1].canStop = true;
  publish();
  await expect(stop).toBeEnabled();
  await expect(stop).not.toHaveAttribute("aria-busy", "true");
});

test("the stop button is a full touch target on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { data, publish } = await subagentFixture(page);
  await taskRoutes(page);
  data.observability.shells = [shell()];
  publish();
  await line(page).click();
  const target = card(page, "bash01");
  for (const name of ["Aufgabe stoppen", "Ausgabe anzeigen"]) {
    const box = await target.getByRole("button", { name }).boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
  await target.getByRole("button", { name: "Ausgabe anzeigen" }).click();
  for (const name of ["Zurück zur Liste", "Aktualisieren"])
    expect(
      (await sheet(page).getByRole("button", { name }).boundingBox()).height,
    ).toBeGreaterThanOrEqual(44);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test.describe("English", () => {
  test.use({ locale: "en-GB" });
  test("cards, detail and stop are translated", async ({ page }) => {
    const { data, publish } = await subagentFixture(page);
    await taskRoutes(page, {
      transcript: () => ({ messages: [], partial: false, truncated: false }),
      stop: () => ({ status: 409, json: refused }),
    });
    data.observability.shells = [shell()];
    publish();
    await expect(line(page)).toHaveText("2 running tasks");
    await line(page).click();
    const dialog = sheet(page, "Background tasks");
    await expect(card(page, "bash01")).toContainText("Shell");
    await expect(card(page, "bash01")).toContainText("Working");
    const agent = card(page, "agentstyles02");
    await agent.getByRole("button", { name: "Stop task" }).click();
    await expect(agent.getByRole("alert")).toHaveText(
      "The CLI refused to stop the task. (Task is not interruptible)",
    );
    await agent.getByRole("button", { name: "Show transcript" }).click();
    await expect(dialog.locator(".background-task-detail")).toContainText(
      "No messages yet.",
    );
    await dialog.getByRole("button", { name: "Back to the list" }).click();
    data.observability.shells = [shell({ status: "stopped", canStop: false })];
    publish();
    await expect(
      group(page, "completed").locator('[data-task-id="bash01"] .subagent-status'),
    ).toHaveText("Stopped");
  });
});
