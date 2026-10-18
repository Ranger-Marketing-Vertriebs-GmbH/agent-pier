import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture, emit } from "../helpers/assistant-chat-fixture.js";

const shots = process.env.AGENTPIER_QUEUE_SHOTS;
const notice = "Will be sent when Home assistant is done";
const stopButton = (page) =>
  page.getByRole("button", { name: "Stop response", exact: true });
const sendWhenDone = (page) =>
  page.getByRole("button", { name: "Send when done", exact: true });
const edit = (page) =>
  page.getByRole("button", { name: "Edit queued message", exact: true });
const field = (page) => page.getByLabel("Message", { exact: true });
const queued = (page) => page.getByRole("group", { name: "Queued message", exact: true });
const notes = {
  id: "file-1",
  name: "notes.md",
  size: 9,
  type: "text/plain",
  kind: "text",
};

// The server side of one agent chat, shared by every tab: its requests, the queued
// message (as queued-dispatch.js keeps it) and what reached the send endpoint.
function agentServer() {
  const server = {
    requests: [],
    queued: null,
    posted: [],
    queuedPosts: [],
    takenBack: 0,
    cancels: [],
    deleted: [],
  };
  server.start = (text = "Plan the week") =>
    server.requests.push({
      id: `request-${server.requests.length + 1}`,
      text,
      state: "accepted",
      attempt: { id: `attempt-${server.requests.length + 1}`, state: "accepted" },
    });
  server.end = (state = "completed") => {
    const latest = server.requests.at(-1);
    latest.attempt = { ...latest.attempt, state };
  };
  // The dispatch after the turn ended: the queued message goes out once.
  server.dispatch = () => {
    const message = server.queued;
    server.queued = null;
    server.posted.push({
      text: message.text,
      ...(message.attachments.length
        ? { attachments: message.attachments.map((f) => f.id) }
        : {}),
    });
    server.start(message.text);
  };
  return server;
}

async function open(page, server, options = {}) {
  await chatFixture(page, options);
  await page.route(/\/api\/assistant-(conversations|attempts)\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const p = url.pathname;
    if (p.endsWith("/cancel")) {
      server.cancels.push(p);
      server.end("cancelled");
      return route.fulfill({ json: { state: "cancelled" } });
    }
    if (p.endsWith("/attachment-policy"))
      return route.fulfill({
        json: { imageInput: true, maxBytes: 10485760, maxFiles: 5 },
      });
    if (p.endsWith("/attachments") && method === "POST")
      return route.fulfill({ status: 201, json: notes });
    if (p.includes("/attachments/") && method === "DELETE") {
      server.deleted.push(p.split("/").at(-1));
      return route.fulfill({ status: 204, body: "" });
    }
    if (p.endsWith("/queued") && method === "POST") {
      const body = request.postDataJSON();
      server.queuedPosts.push(body);
      await server.hold?.();
      if (server.dropNext) {
        server.dropNext = false;
        return route.abort("connectionreset");
      }
      // A repeated submission (same appendId) changes nothing, as on the server.
      if (body.appendId && server.queued?.lastAppend === body.appendId)
        return route.fulfill({ json: server.queued });
      const text = [server.queued?.text, body.text]
        .map((part) => String(part || "").trimEnd())
        .filter((part) => part.trim())
        .join("\n");
      if (text.length > 65536)
        return route.fulfill({
          status: 413,
          json: {
            error:
              "Die wartende Nachricht hat keinen Platz für mehr Text. Bearbeite sie zuerst.",
            messageKey: "assistants.queuedTooLong",
          },
        });
      server.queued = {
        text,
        teamAllowed: Boolean(server.queued?.teamAllowed || body.teamAllowed),
        attachments: [
          ...(server.queued?.attachments || []),
          ...(body.attachments || []).map(() => notes),
        ],
        state: "waiting",
        lastAppend: body.appendId,
      };
      return route.fulfill({ json: server.queued });
    }
    if (p.endsWith("/queued") && method === "DELETE") {
      if (!server.queued) return route.fulfill({ status: 404, json: { error: "Weg." } });
      const { text, teamAllowed, attachments } = server.queued;
      server.queued = null;
      server.takenBack++;
      return route.fulfill({ json: { text, teamAllowed, attachments } });
    }
    if (p.endsWith("/messages")) {
      if (method === "POST") {
        server.posted.push(request.postDataJSON());
        server.start(request.postDataJSON().text);
      }
      return route.fulfill({
        json: {
          messages: [],
          requests: server.requests,
          queued: server.queued,
          stale: false,
        },
      });
    }
    return route.fallback();
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(field(page)).toBeVisible();
}
const changed = (page) => emit(page, { type: "change" });

test("Enter while the agent works queues the message on the server instead of stopping it", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Enter breaks the line on touch input");
  const server = agentServer();
  server.start();
  await open(page, server);
  await expect(stopButton(page)).toBeVisible();
  await field(page).pressSequentially("And add a dessert");
  await field(page).press("Enter");
  await expect(queued(page)).toContainText("And add a dessert");
  await expect(queued(page)).toContainText(notice);
  await expect(field(page)).toHaveValue("");
  await expect(field(page)).toBeFocused();
  await expect(stopButton(page)).toBeVisible();
  expect(server.cancels).toEqual([]);
  expect(server.posted).toEqual([]);
  expect(server.queuedPosts).toEqual([
    { text: "And add a dessert", appendId: expect.any(String) },
  ]);

  // A second Enter adds to the same queued message, on its own line.
  await field(page).pressSequentially("Without nuts");
  await field(page).press("Enter");
  await expect(queued(page)).toContainText("Without nuts");
  await expect(queued(page)).toHaveCount(1);

  // The server sends it once the turn ended; the chat shows the new turn.
  server.end();
  server.dispatch();
  await changed(page);
  await expect(queued(page)).toHaveCount(0);
  await expect(stopButton(page)).toBeVisible();
  expect(server.posted).toEqual([{ text: "And add a dessert\nWithout nuts" }]);
  expect(server.cancels).toEqual([]);
});

test("a reload and a second tab keep showing the queued message", async ({ page }) => {
  const server = agentServer();
  server.start();
  await open(page, server);
  await field(page).fill("Swap Tuesday and Friday");
  await sendWhenDone(page).click();
  await expect(queued(page)).toContainText("Swap Tuesday and Friday");
  await page.reload();
  await expect(queued(page)).toContainText("Swap Tuesday and Friday");
  await expect(queued(page)).toContainText(notice);

  const other = await page.context().newPage();
  await open(other, server);
  await expect(queued(other)).toContainText("Swap Tuesday and Friday");
  // Taken back in one tab, the other drops it with the next change.
  await edit(other).click();
  await expect(field(other)).toHaveValue("Swap Tuesday and Friday");
  await changed(page);
  await expect(queued(page)).toHaveCount(0);
  await other.close();
});

test("Edit takes the queued message and its files back into the composer", async ({
  page,
}) => {
  const server = agentServer();
  server.start();
  await open(page, server);
  await page.locator('input[type="file"]').setInputFiles({
    name: "notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Dessert"),
  });
  await expect(page.getByRole("list", { name: "Attachments" })).toContainText("notes.md");
  await field(page).fill("Use these notes");
  await sendWhenDone(page).click();
  await expect(queued(page)).toContainText("1 file");
  expect(server.queuedPosts).toEqual([
    { text: "Use these notes", attachments: ["file-1"], appendId: expect.any(String) },
  ]);
  // The server owns the files now: the tray lets go of them without deleting them.
  await expect(page.getByRole("list", { name: "Attachments" })).toHaveCount(0);
  await field(page).fill("Also Sunday");
  await edit(page).click();
  await expect(queued(page)).toHaveCount(0);
  await expect(field(page)).toHaveValue("Use these notes\nAlso Sunday");
  await expect(page.getByRole("list", { name: "Attachments" })).toContainText("notes.md");
  expect(server.deleted).toEqual([]);
  expect(server.posted).toEqual([]);
});

test("Stop still stops the turn while a message is queued", async ({ page }) => {
  const server = agentServer();
  server.start();
  await open(page, server);
  await field(page).fill("Start over with fish");
  await sendWhenDone(page).click();
  await expect(queued(page)).toBeVisible();
  await stopButton(page).click();
  await expect
    .poll(() => server.cancels)
    .toEqual(["/api/assistant-attempts/attempt-1/cancel"]);
  // Until the server sends it, nothing overtakes it: the next message joins it.
  await expect(stopButton(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  await field(page).fill("And keep it light");
  await sendWhenDone(page).click();
  await expect(queued(page)).toContainText("And keep it light");
  expect(server.posted).toEqual([]);
});

test("the notice says when the message waits, is on its way or was refused", async ({
  page,
  isMobile,
}) => {
  const server = agentServer();
  server.start();
  await open(page, server);
  await field(page).fill("Next step");
  await sendWhenDone(page).click();
  const live = page.locator(".assistant-queued-live");
  await expect(live).toHaveAttribute("role", "status");
  await expect(live).toHaveText(notice);

  // On its way: no Edit, and focus that was on Edit moves to the field.
  if (!isMobile) await edit(page).focus();
  server.queued = { ...server.queued, state: "sending" };
  await changed(page);
  await expect(queued(page)).toContainText("Sending now …");
  await expect(edit(page)).toHaveCount(0);
  if (!isMobile) await expect(field(page)).toBeFocused();

  server.end();
  server.queued = {
    ...server.queued,
    state: "failed",
    error: "Dieser Anhang ist nicht mehr verfügbar. Füge die Datei erneut hinzu.",
    messageKey: "assistants.attachmentNotFound",
  };
  await changed(page);
  await expect(queued(page)).toContainText(
    "Not sent: This attachment is no longer available. Add the file again.",
  );
  await expect(edit(page)).toBeVisible();
  await expect(live).toContainText("Not sent:");
});

test("a waiting message names an agent that cannot take messages now", async ({
  page,
}) => {
  const server = agentServer();
  server.start();
  server.end();
  server.queued = {
    text: "Later",
    teamAllowed: false,
    attachments: [],
    state: "waiting",
  };
  await open(page, server, {
    runtime: { availability: "reconnecting", sync: "current" },
  });
  await expect(queued(page)).toContainText(
    "Not sent yet: Home assistant can't take messages right now",
  );
});

test("a queued message never grows past the message limit", async ({ page }) => {
  const server = agentServer();
  server.start();
  await open(page, server);
  await field(page).fill("a".repeat(60000));
  await sendWhenDone(page).click();
  await expect(queued(page)).toBeVisible();
  await field(page).fill("b".repeat(6000));
  await sendWhenDone(page).click();
  await expect(page.getByRole("alert")).toContainText(
    "The queued message has no room for more text. Edit it first.",
  );
  await expect(field(page)).toHaveValue("b".repeat(6000));
});

test("a message sent from a focused Send button never lets Enter reach Stop", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "keyboard focus on buttons is a desktop interaction");
  const server = agentServer();
  await open(page, server);
  await field(page).fill("Plan the week");
  await page.getByRole("button", { name: "Send", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(stopButton(page)).toBeVisible();
  await expect(stopButton(page)).not.toBeFocused();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  expect(server.cancels).toEqual([]);
  await expect(stopButton(page)).toBeVisible();
});

test("on a phone, Send when done queues next to Stop", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const server = agentServer();
  server.start();
  await open(page, server);
  await expect(page.getByRole("button", { name: "Send when done" })).toHaveCount(0);
  await field(page).fill("Add a shopping list");
  await expect(sendWhenDone(page)).toBeVisible();
  const [laterBox, stopBox] = [
    await sendWhenDone(page).boundingBox(),
    await stopButton(page).boundingBox(),
  ];
  expect(laterBox.x + laterBox.width).toBeLessThanOrEqual(stopBox.x);
  expect(Math.abs(laterBox.y - stopBox.y)).toBeLessThanOrEqual(2);
  if (shots) await page.screenshot({ path: `${shots}/send-when-done-phone-en.png` });
  await sendWhenDone(page).click();
  await expect(queued(page)).toContainText("Add a shopping list");
  await expect(edit(page)).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
  if (shots) await page.screenshot({ path: `${shots}/queued-phone-en.png` });
});

test("a double submit queues the text once, and a retry repeats its key", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Enter breaks the line on touch input");
  const server = agentServer();
  server.start();
  await open(page, server);
  let release;
  server.hold = () => new Promise((resolve) => (release = resolve));
  await field(page).fill("Add a dessert");
  await field(page).press("Enter");
  await expect.poll(() => server.queuedPosts.length).toBe(1);
  await sendWhenDone(page).click();
  await field(page).press("Enter");
  server.hold = null;
  release();
  await expect(queued(page)).toContainText("Add a dessert");
  await page.waitForTimeout(300);
  expect(server.queuedPosts).toHaveLength(1);
  expect(server.queued.text).toBe("Add a dessert");

  // A lost answer: the same submission goes out again under the same key.
  server.dropNext = true;
  await field(page).fill("Without nuts");
  await field(page).press("Enter");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(field(page)).toHaveValue("Without nuts");
  await field(page).press("Enter");
  await expect(queued(page)).toContainText("Without nuts");
  expect(server.queuedPosts).toHaveLength(3);
  expect(server.queuedPosts[2].appendId).toBe(server.queuedPosts[1].appendId);
  expect(server.queuedPosts[1].appendId).not.toBe(server.queuedPosts[0].appendId);
});

test("the announcement stays put while the agent flips between waiting and blocked", async ({
  page,
}) => {
  const server = agentServer();
  server.start();
  server.end();
  server.queued = {
    text: "Later",
    teamAllowed: false,
    attachments: [],
    state: "waiting",
  };
  await open(page, server, {
    runtime: { availability: "reconnecting", sync: "current" },
  });
  await expect(queued(page)).toContainText("Not sent yet");
  // Shown on the card, but not announced again and again.
  await expect(page.locator(".assistant-queued-live")).toHaveText(notice);
});

test("a message that keeps being retried says so", async ({ page }) => {
  const server = agentServer();
  server.start();
  server.end();
  server.queued = {
    text: "Later",
    teamAllowed: false,
    attachments: [],
    state: "waiting",
    retrying: true,
  };
  await open(page, server);
  await expect(queued(page)).toContainText(
    "Not sent yet: AgentPier keeps trying to send it to Home assistant",
  );
  await expect(edit(page)).toBeVisible();
});
