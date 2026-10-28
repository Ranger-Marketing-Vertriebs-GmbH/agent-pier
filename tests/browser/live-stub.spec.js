import { fulfillDormantAssistantRequest } from "../helpers/assistant-browser-fixture.js";
import { test, expect } from "../helpers/browser-test.js";
import { baseURL as base } from "../helpers/browser.js";
import { isLiveStubRequest, stubContext } from "../helpers/live-stub.js";
import { recordApiRequests, setTabHidden } from "../helpers/visibility.js";

// The live socket stub of tests/helpers/live-stub.js (docs/testing.md#live-socket-stub).
// The sidebar tests follow the `state` topic through the app; the raw-socket tests
// drive the stub directly.
const session = (id, name) => ({
  id,
  name,
  tool: "codex",
  accountId: "local-codex",
  cwd: `/work/${id}`,
  status: "running",
  activity: { state: "idle", label: "Bereit" },
});
const stateOf = (sessions) => ({
  tools: [],
  accounts: [{ id: "local-codex", tool: "codex", name: "Lokal", kind: "local" }],
  sessions,
  home: "/work",
});

// `target` is a page or a context: both take the same routes.
async function fixture(target) {
  const server = {
    sessions: [session("first", "Projekt Eins")],
    models: { picker: null, pending: false },
  };
  await target.route("**/api/**", async (route) => {
    if (await fulfillDormantAssistantRequest(route)) return;
    const path = new URL(route.request().url()).pathname;
    const data =
      path === "/api/state"
        ? stateOf(server.sessions)
        : path === "/api/sessions/one/models"
          ? server.models
          : path === "/api/pipeline-runs"
            ? { runs: [], total: 0, page: 1, pageSize: 20 }
            : path === "/api/pipelines"
              ? { pipelines: [] }
              : path === "/api/pipeline-profiles"
                ? { profiles: [] }
                : path === "/api/memory/projects"
                  ? { projects: [] }
                  : {};
    await route.fulfill({ json: data });
  });
  return server;
}
const sessionList = (page) => page.locator(".sessions-group .session-list");

test("rest mode follows a REST mock that changes mid-test", async ({
  page,
  liveStub,
}) => {
  const server = await fixture(page);
  await page.goto(base);
  await liveStub.waitForSubscribe("state");
  await expect(sessionList(page).getByText("Projekt Eins")).toBeVisible();
  server.sessions = [...server.sessions, session("second", "Projekt Zwei")];
  await expect(sessionList(page).getByText("Projekt Zwei")).toBeVisible({
    timeout: 6000,
  });
});

test("a spec that closes every /api socket still gets data through the fallback", async ({
  page,
  liveStub,
}) => {
  await fixture(page);
  liveStub.refuse();
  await page.goto(base);
  await expect(sessionList(page).getByText("Projekt Eins")).toBeVisible({
    timeout: 6000,
  });
});

test.describe("manual mode", () => {
  test.use({ live: "manual" });

  test("manual mode pushes exactly what the test sends", async ({ page, liveStub }) => {
    await fixture(page);
    await page.goto(base);
    await liveStub.waitForSubscribe("state");
    liveStub.push("state", stateOf([session("pushed", "Projekt Gesendet")]));
    await expect(sessionList(page).getByText("Projekt Gesendet")).toBeVisible();
    await expect(sessionList(page).getByText("Projekt Eins")).toHaveCount(0);
  });
});

// A WebSocket of the test itself on /api/live; frames land in window.__live.
async function openRaw(page) {
  await page.evaluate(() => {
    const live = { frames: [], closed: null, opened: false };
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    live.socket = new WebSocket(`${scheme}://${location.host}/api/live`);
    live.socket.onmessage = (event) => live.frames.push(JSON.parse(event.data));
    live.socket.onclose = (event) => (live.closed = event.code);
    window.__live = live;
  });
  return {
    frames: () => page.evaluate(() => window.__live.frames),
    closed: () => page.evaluate(() => window.__live.closed),
    send: (frame) =>
      page.evaluate((value) => window.__live.socket.send(JSON.stringify(value)), frame),
  };
}
const types = (frames) => frames.map((frame) => frame.type);
// The session names a snapshot carries, or a delta adds or changes.
const rowNames = (frame) =>
  (frame.data.messages || frame.data.upserts)
    .filter((row) => row.section === "sessions")
    .map((row) => row.value.name);

test("the stub answers a raw sub from the REST mock and follows it", async ({ page }) => {
  const server = await fixture(page);
  await page.goto(base);
  const recorder = recordApiRequests(page);
  const reads = { app: 0, stub: 0 };
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/state")
      reads[isLiveStubRequest(request) ? "stub" : "app"]++;
  });
  const raw = await openRaw(page);
  await expect.poll(async () => types(await raw.frames())).toEqual(["hello"]);
  await raw.send({ op: "sub", topic: "state" });
  await expect.poll(async () => (await raw.frames()).length).toBe(2);
  const [, snapshot] = await raw.frames();
  expect(snapshot).toMatchObject({ type: "snapshot", topic: "state" });
  expect(snapshot.data.sync).toEqual({ mode: "full", cursor: expect.any(String) });
  expect(rowNames(snapshot)).toEqual(["Projekt Eins"]);
  server.sessions = [session("second", "Projekt Zwei")];
  await expect
    .poll(async () => (await raw.frames()).slice(2).map(rowNames), { timeout: 6000 })
    .toEqual([["Projekt Zwei"]]);
  // A later frame of a rows topic is a delta onto the subscription's last one.
  expect((await raw.frames())[2]).toMatchObject({
    type: "delta",
    data: { removed: ["sessions/first"] },
  });
  // The recorder sees the app's own reads, never the stub's.
  expect(reads.stub).toBeGreaterThanOrEqual(2);
  expect(recorder.list().filter(({ path }) => path === "/api/state")).toHaveLength(
    reads.app,
  );
});

test("a hidden tab pauses sampled topics only, as the server does", async ({ page }) => {
  const server = await fixture(page);
  await page.goto(base);
  const raw = await openRaw(page);
  await expect.poll(async () => types(await raw.frames())).toEqual(["hello"]);
  await raw.send({ op: "sub", topic: "state" });
  await raw.send({ op: "sub", topic: "session.models:one" });
  await expect.poll(async () => (await raw.frames()).length).toBe(3);
  await setTabHidden(page, true);
  const reads = [];
  page.on("request", (request) => {
    if (isLiveStubRequest(request)) reads.push(new URL(request.url()).pathname);
  });
  server.sessions = [session("second", "Projekt Zwei")];
  server.models = { picker: null, pending: true };
  const after = (topic) => async () =>
    (await raw.frames()).slice(3).filter((frame) => frame.topic === topic);
  await expect
    .poll(async () => (await after("state")()).map(rowNames), { timeout: 6000 })
    .toEqual([["Projekt Zwei"]]);
  await page.waitForTimeout(3500);
  expect(reads).not.toContain("/api/sessions/one/models");
  expect(await after("session.models:one")()).toEqual([]);
  await setTabHidden(page, false);
  await expect
    .poll(async () => (await after("session.models:one")()).map((frame) => frame.data), {
      timeout: 6000,
    })
    .toEqual([{ picker: null, pending: true }]);
});

test("later tabs of the default context and a spec's own context are stubbed", async ({
  page,
  context,
  browser,
}) => {
  await fixture(context);
  await page.goto(base);
  const second = await context.newPage();
  await second.goto(base);
  const tab = await openRaw(second);
  await expect.poll(async () => types(await tab.frames())[0]).toBe("hello");
  await tab.send({ op: "sub", topic: "state" });
  await expect
    .poll(async () => (await tab.frames()).filter((f) => f.type === "snapshot").length)
    .toBe(1);

  const own = await browser.newContext({ storageState: await context.storageState() });
  try {
    const stubs = await stubContext(own, { mode: "manual" });
    await fixture(own);
    const phone = await own.newPage();
    await phone.goto(base);
    const raw = await openRaw(phone);
    await expect.poll(async () => types(await raw.frames())).toEqual(["hello"]);
    await raw.send({ op: "sub", topic: "state" });
    const stub = await stubs.stubFor(phone);
    await stub.waitForSubscribe("state");
    stub.push("state", stateOf([session("pushed", "Projekt Gesendet")]));
    await expect
      .poll(async () => (await raw.frames()).slice(1).map(rowNames))
      .toEqual([["Projekt Gesendet"]]);
  } finally {
    await own.close();
  }
});

test("a sub whose have is not an object closes with 1008", async ({ page }) => {
  await fixture(page);
  await page.goto(base);
  const raw = await openRaw(page);
  await expect.poll(async () => types(await raw.frames())).toEqual(["hello"]);
  await raw.send({ op: "sub", topic: "state", have: "revision-1" });
  await expect.poll(() => raw.closed()).toBe(1008);
});

test.describe("manual stub", () => {
  test.use({ live: "manual" });

  test("sends only pushes and answers pings and unknown topics", async ({
    page,
    liveStub,
  }) => {
    await fixture(page);
    await page.goto(base);
    const raw = await openRaw(page);
    await expect.poll(async () => types(await raw.frames())).toEqual(["hello"]);
    await raw.send({ op: "sub", topic: "session.models:one" });
    await raw.send({ op: "sub", topic: "nope" });
    await raw.send({ op: "ping" });
    await liveStub.waitForSubscribe("session.models:one");
    await expect
      .poll(async () => types(await raw.frames()))
      .toEqual(["hello", "error", "pong"]);
    // The app's own page follows `state`, its start page `inbox`.
    expect(liveStub.subscriptions().sort()).toEqual([
      "inbox",
      "session.models:one",
      "state",
    ]);
    liveStub.push("session.models:one", { picker: null, pending: true });
    liveStub.push("session.models:one", { picker: null, pending: false });
    liveStub.changed("session.models:one");
    await expect
      .poll(async () => (await raw.frames()).slice(3))
      .toEqual([
        expect.objectContaining({
          type: "snapshot",
          data: { picker: null, pending: true },
        }),
        expect.objectContaining({
          type: "state",
          data: { picker: null, pending: false },
        }),
        expect.objectContaining({ type: "changed", topic: "session.models:one" }),
      ]);
    expect((await raw.frames())[1]).toEqual({
      type: "error",
      topic: "nope",
      code: "unknown-topic",
    });
    liveStub.revoke("session.models:one");
    await expect.poll(async () => types(await raw.frames()).at(-1)).toBe("revoked");
    expect(liveStub.subscriptions().sort()).toEqual(["inbox", "state"]);
    liveStub.close(1012);
    await expect.poll(() => raw.closed()).toBe(1012);
  });
});

test("refuse() closes the socket before hello", async ({ page, liveStub }) => {
  await fixture(page);
  await page.goto(base);
  liveStub.refuse();
  const refused = await openRaw(page);
  await expect.poll(() => refused.closed()).not.toBeNull();
  expect(await refused.frames()).toEqual([]);
});

test("a spec's own /api/** socket route wins over the stub", async ({ page }) => {
  await fixture(page);
  await page.goto(base);
  await page.routeWebSocket("**/api/**", (socket) => socket.close());
  const closed = await openRaw(page);
  await expect.poll(() => closed.closed()).not.toBeNull();
  expect(await closed.frames()).toEqual([]);
});

test.describe("real mode", () => {
  test.use({ live: "real" });

  test("has no stub and reaches the test server", async ({ page, liveStub }) => {
    expect(liveStub).toBeNull();
    await page.goto(base);
    const raw = await openRaw(page);
    await expect.poll(async () => types(await raw.frames())).toEqual(["hello"]);
  });
});
