import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";

// The session chat follows the live `session.requests:<id>` and `session.models:<id>`
// topics: a pushed frame shows a native request, and the page itself reads neither
// /requests nor /models over REST while the channel works.
test.use({ live: "manual" });

const requestsTopic = "session.requests:fixture-session";
const modelsTopic = "session.models:fixture-session";
const request = {
  id: "pushed-request",
  sessionId: "fixture-session",
  kind: "permission",
  revision: 1,
  status: "pending",
  source: "codex",
  createdAt: "2026-10-28T08:00:00Z",
  options: [
    { id: "allow", label: "Allow pushed" },
    { id: "deny", label: "Deny pushed" },
  ],
  subject: { command: "pushed command" },
};

async function open(page, liveStub) {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await operationsFixture(page);
  const reads = [];
  page.on("request", (sent) => {
    const { pathname } = new URL(sent.url());
    if (sent.method() === "GET" && /\/(requests|models)$/.test(pathname))
      reads.push(pathname);
  });
  await page.goto(baseURL + "/sessions/fixture-session/chat");
  await liveStub.waitForSubscribe("state");
  // The workspace state from the fixture's REST mock, pushed as the server would.
  const state = await page.evaluate(() => fetch("/api/state").then((r) => r.json()));
  liveStub.push("state", state);
  await liveStub.waitForSubscribe(requestsTopic);
  await liveStub.waitForSubscribe(modelsTopic);
  return reads;
}

test("a pushed request frame shows the native request card", async ({
  page,
  liveStub,
}) => {
  await open(page, liveStub);
  liveStub.push(requestsTopic, { requests: [] });
  liveStub.push(modelsTopic, { currentModel: null, picker: null, pending: false });
  await expect(page.getByText("pushed command")).toHaveCount(0);
  liveStub.push(requestsTopic, { requests: [request] });
  await expect(
    page.getByRole("button", { name: "Allow pushed", exact: true }),
  ).toBeVisible();
  liveStub.push(requestsTopic, { requests: [] });
  await expect(
    page.getByRole("button", { name: "Allow pushed", exact: true }),
  ).toHaveCount(0);
});

test("the session chat reads no requests or models for 10 s after load", async ({
  page,
  liveStub,
}) => {
  const reads = await open(page, liveStub);
  liveStub.push(requestsTopic, { requests: [] });
  liveStub.push(modelsTopic, { currentModel: "gpt-5", picker: null, pending: false });
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeEnabled();
  await page.waitForTimeout(10000);
  expect(reads).toEqual([]);
});

// useModelControl holds a push that arrives during the tab's own model change and
// applies it once the change settles, so the newer screen state is not lost.
test("a model push during a model change is applied once the change settles", async ({
  page,
  liveStub,
}) => {
  await open(page, liveStub);
  const settled = { currentModel: "gpt-5.6-sol", picker: null, pending: false };
  liveStub.push(requestsTopic, { requests: [] });
  liveStub.push(modelsTopic, settled);
  const trigger = page.getByRole("button", { name: "Choose model", exact: true });
  await expect(trigger).toContainText("gpt-5.6-sol");
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let opened = false;
  await page.route("**/api/sessions/fixture-session/models/open", async (route) => {
    opened = true;
    await held;
    await route.fulfill({ json: settled }).catch(() => {});
  });
  await trigger.click();
  await expect.poll(() => opened).toBe(true);
  liveStub.push(modelsTopic, { ...settled, currentModel: "gpt-6-astra" });
  // Held while the change is under way.
  await page.waitForTimeout(500);
  await expect(trigger).toContainText("gpt-5.6-sol");
  release();
  await expect(trigger).toContainText("gpt-6-astra");
});
