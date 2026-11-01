import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { freePortRange } from "../helpers/preview-ports.js";
import { openSocket, send, startUpstream } from "../helpers/preview-proxy-fixture.js";
import { issue } from "../helpers/session-mcp.js";
import { portAvailable } from "../../server/features/pipelines/run-ports.js";
import { createPreviewService } from "../../server/application/preview-wiring.js";

/**
 * An app whose config enables previews on `count` free ports. Without `realOwners`
 * every session counts as running, so tests can name sessions that tmux never ran.
 */
async function previewApp(t, { count = 4, enabled = true, before, realOwners } = {}) {
  const range = await freePortRange(count);
  const held = await before?.(range);
  const f = await applicationFixture(t, {
    prepareDataDir: async (dataDir) => {
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(dataDir, "config.json"),
        JSON.stringify({
          previews: { enabled, portRangeStart: range.start, portRangeEnd: range.end },
        }),
      );
    },
  });
  const previews = f.application.previews;
  if (!realOwners) previews.sessionAlive = () => true;
  await previews.start();
  return { f, range, previews, held };
}

const sessionOwner = (f, sessionId = "s1") => ({
  kind: "session",
  sessionId,
  project: f.project,
});
const agentOwner = {
  kind: "agent",
  assistantId: "a1",
  conversationId: "c1",
  project: "a1",
};

/** A port nothing listens on. */
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A foreign server on `port`, closed after the test. */
async function occupy(t, port) {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

const through = (f, slot, url = "/") =>
  send(slot, { path: url, headers: { host: `127.0.0.1:${slot}`, cookie: f.cookie } });

test("open answers id, url, port and label; the same session and port reuse the preview", async (t) => {
  const upstream = await startUpstream(t);
  const { f, range, previews } = await previewApp(t);
  const first = await previews.open({
    owner: sessionOwner(f),
    port: upstream.port,
    label: "A",
    path: "/admin",
  });
  const [listed] = previews.list({ sessionId: "s1" });
  assert.ok(listed.slot >= range.start && listed.slot <= range.end);
  assert.deepEqual(first, {
    id: listed.id,
    url: `http://127.0.0.1:${listed.slot}/admin`,
    port: upstream.port,
    label: "A",
  });
  assert.equal(listed.project, undefined);
  assert.deepEqual(listed.owner, { kind: "session", sessionId: "s1" });
  const again = await previews.open({
    owner: sessionOwner(f),
    port: upstream.port,
    label: "B",
  });
  assert.equal(again.id, first.id);
  assert.equal(again.label, "B");
  // A re-open without a path keeps the one opened before.
  assert.equal(again.url, first.url);
  assert.equal(previews.list()[0].path, "/admin");
  assert.equal(previews.list().length, 1);
});

test("two sessions of one project on the same target port get two slots", async (t) => {
  const upstream = await startUpstream(t);
  const { f, previews } = await previewApp(t);
  await previews.open({ owner: sessionOwner(f, "s1"), port: upstream.port, label: "A" });
  await previews.open({ owner: sessionOwner(f, "s2"), port: upstream.port, label: "A" });
  const [one, two] = previews.list();
  assert.notEqual(one.id, two.id);
  assert.notEqual(one.slot, two.slot);
});

test("open refuses AgentPier's own port, a port in the range and a closed port", async (t) => {
  const { f, range, previews } = await previewApp(t);
  const owner = sessionOwner(f);
  const own = f.application.server.address().port;
  await assert.rejects(previews.open({ owner, port: own, label: "A" }), {
    code: "PREVIEW_PORT_FORBIDDEN",
    status: 403,
  });
  await assert.rejects(previews.open({ owner, port: range.start, label: "A" }), {
    code: "PREVIEW_PORT_FORBIDDEN",
  });
  await assert.rejects(previews.open({ owner, port: await closedPort(), label: "A" }), {
    code: "PREVIEW_NOT_LISTENING",
    status: 409,
  });
  for (const input of [
    { port: 0, label: "A" },
    { port: 3000.5, label: "A" },
    { port: 3000, label: "" },
    { port: 3000, label: "x".repeat(81) },
    { port: 3000, label: "a\nb" },
    { port: 3000, label: "A", path: "admin" },
    { port: 3000, label: "A", path: "//evil.example" },
    { port: 3000, label: "A", path: `/${"x".repeat(2048)}` },
  ])
    await assert.rejects(previews.open({ owner, ...input }), {
      code: "PREVIEW_INVALID_INPUT",
      status: 400,
    });
});

test("open accepts a target listening only on ::1", async (t) => {
  let upstream;
  try {
    upstream = await startUpstream(t, { host: "::1" });
  } catch {
    return t.skip("IPv6 loopback unavailable");
  }
  const { f, previews } = await previewApp(t);
  const opened = await previews.open({
    owner: sessionOwner(f),
    port: upstream.port,
    label: "Six",
  });
  assert.equal(previews.list()[0].id, opened.id);
  assert.equal(previews.list()[0].target, upstream.port);
});

test("disabled previews answer PREVIEW_DISABLED and bind nothing", async (t) => {
  const upstream = await startUpstream(t);
  const { f, range, previews } = await previewApp(t, { enabled: false });
  assert.deepEqual(previews.settings(), {
    enabled: false,
    portRangeStart: range.start,
    portRangeEnd: range.end,
  });
  await assert.rejects(
    previews.open({ owner: sessionOwner(f), port: upstream.port, label: "A" }),
    { code: "PREVIEW_DISABLED", status: 409 },
  );
  for (let port = range.start; port <= range.end; port++)
    assert.equal(await portAvailable(port), true);
});

test("the range full answers PREVIEW_RANGE_FULL", async (t) => {
  const one = await startUpstream(t);
  const two = await startUpstream(t);
  const { f, previews } = await previewApp(t, { count: 1 });
  await previews.open({ owner: sessionOwner(f), port: one.port, label: "A" });
  await assert.rejects(
    previews.open({ owner: sessionOwner(f), port: two.port, label: "B" }),
    { code: "PREVIEW_RANGE_FULL", status: 409 },
  );
});

test("stopping, removing the session or revoking its MCP grant closes its previews", async (t) => {
  const upstream = await startUpstream(t);
  const { f, previews } = await previewApp(t, { realOwners: true });
  const sessions = f.application.sessions;
  // A session without a live MCP grant opens nothing.
  await assert.rejects(
    previews.open({ owner: sessionOwner(f, "never-ran"), port: upstream.port }),
    { code: "PREVIEW_NOT_FOUND", status: 404 },
  );
  const stopped = await issue(f);
  const id = stopped.session.id;
  const opened = await previews.open({
    owner: sessionOwner(f, id),
    port: upstream.port,
    label: "A",
  });
  const [{ slot }] = previews.list({ sessionId: id });
  const live = await through(f, slot, "/page");
  assert.equal(live.status, 200);
  assert.equal(live.body, "GET /page ");
  await sessions.stop(id);
  assert.deepEqual(previews.list({ sessionId: id }), []);
  const idle = await through(f, slot);
  assert.equal(idle.status, 404);

  await assert.rejects(
    previews.open({ owner: sessionOwner(f, id), port: upstream.port, label: "A" }),
    { code: "PREVIEW_NOT_FOUND", status: 404 },
  );
  // A preview left from a race with the stop ends with the session's removal.
  const realAlive = previews.sessionAlive;
  previews.sessionAlive = () => true;
  await previews.open({ owner: sessionOwner(f, id), port: upstream.port, label: "A" });
  previews.sessionAlive = realAlive;
  await sessions.remove(id);
  assert.deepEqual(previews.list({ sessionId: id }), []);

  const revoked = await issue(f);
  await previews.open({
    owner: sessionOwner(f, revoked.session.id),
    port: upstream.port,
    label: "A",
  });
  await f.application.sessionMcp.revoke(revoked.session.id);
  assert.deepEqual(previews.list({ sessionId: revoked.session.id }), []);
  assert.ok(opened.id);
  const reasons = f.application.audit
    .list({ action: "preview.stopped" })
    .events.map((event) => event.details.reason)
    .sort();
  assert.deepEqual(reasons, ["revoked", "session", "session"]);
});

test("an agent preview expires 24 hours after its last request", async (t) => {
  const upstream = await startUpstream(t);
  const { f, previews: started } = await previewApp(t);
  await started.shutdown();
  let clock = Date.parse("2026-11-01T10:00:00Z");
  const previews = createPreviewService(f.application, {
    now: () => clock,
    idleMs: 1000,
    agentAlive: () => true,
  });
  t.after(() => previews.shutdown());
  await previews.start();
  await previews.open({ owner: agentOwner, port: upstream.port, label: "Agent" });
  const [{ slot }] = previews.list({ conversationId: "c1" });
  clock += 900;
  assert.equal((await through(f, slot)).status, 200);
  clock += 900;
  await previews.sweep();
  assert.equal(previews.list().length, 1);
  clock += 1000;
  await previews.sweep();
  assert.deepEqual(previews.list(), []);
  const [expired] = f.application.audit.list({ action: "preview.expired" }).events;
  assert.equal(expired.source, "system");
  assert.deepEqual(expired.details, {
    kind: "preview",
    owner: "agent",
    targetPort: upstream.port,
    slot,
    reason: "expired",
  });
});

test("start binds every free slot and serves the idle page", async (t) => {
  const { f, range, previews } = await previewApp(t, {
    before: (range) => occupy(t, range.start + 1),
  });
  const view = await previews.view();
  assert.deepEqual(
    view.slots.map((slot) => slot.state),
    ["free", "taken", "free", "free"],
  );
  assert.deepEqual(view.slots[0], { port: range.start, state: "free" });
  assert.equal(view.serve, null);
  assert.deepEqual(view.previews, []);
  assert.equal(view.settings.enabled, true);
  for (const port of [range.start, range.start + 2, range.start + 3])
    assert.equal(await portAvailable(port), false);
  const idle = await through(f, range.start);
  assert.equal(idle.status, 404);
  assert.match(idle.headers["content-type"], /text\/html/);
});

test("open, close and expire are audited without URLs or headers", async (t) => {
  const upstream = await startUpstream(t);
  const { f, previews } = await previewApp(t);
  const opened = await previews.open({
    owner: sessionOwner(f),
    port: upstream.port,
    label: "A",
    path: "/admin?token=secret",
  });
  assert.match(opened.url, /\/admin\?token=secret$/);
  const [{ slot }] = previews.list();
  await assert.rejects(previews.close("missing", { reason: "owner", source: "user" }), {
    code: "PREVIEW_NOT_FOUND",
    status: 404,
  });
  assert.deepEqual(await previews.close(opened.id, { reason: "tool", source: "mcp" }), {
    closed: true,
  });
  const audit = f.application.audit;
  const [started] = audit.list({ action: "preview.started" }).events;
  const [stopped] = audit.list({ action: "preview.stopped" }).events;
  assert.equal(started.resourceType, "preview");
  assert.equal(started.resourceId, opened.id);
  assert.equal(started.sessionId, "s1");
  assert.equal(started.source, "mcp");
  assert.deepEqual(started.details, {
    kind: "preview",
    owner: "session",
    targetPort: upstream.port,
    slot,
    reason: "tool",
  });
  assert.equal(stopped.source, "mcp");
  assert.equal(stopped.details.reason, "tool");
  const text = JSON.stringify([started, stopped]);
  assert.doesNotMatch(text, /\?|token|secret|cookie|admin|127\.0\.0\.1/i);
});

test("closing a preview ends its WebSockets and event streams", async (t) => {
  const upstream = await startUpstream(t, {
    handler: (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
    },
  });
  const { f, previews } = await previewApp(t, { realOwners: true });
  const { session } = await issue(f);
  await previews.open({ owner: sessionOwner(f, session.id), port: upstream.port });
  const [{ slot }] = previews.list({ sessionId: session.id });
  const host = `127.0.0.1:${slot}`;
  const socket = await openSocket(slot, { host, cookie: f.cookie });
  socket.on("error", () => {});
  const socketClosed = new Promise((resolve) => socket.once("close", resolve));
  const req = http.request({
    host: "127.0.0.1",
    port: slot,
    path: "/events",
    headers: { host, cookie: f.cookie },
    agent: false,
  });
  req.on("error", () => {});
  req.end();
  const [res] = await once(req, "response");
  res.on("error", () => {});
  await once(res, "data");
  // events.once would reject on the reset's error event; only the close matters.
  const streamClosed = new Promise((resolve) => res.once("close", resolve));
  await f.application.sessions.stop(session.id);
  await socketClosed;
  await streamClosed;
  assert.equal(res.complete, false);
});
