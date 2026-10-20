import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { signedInUser } from "../helpers/users.js";
import { routeInventory } from "../../server/http/route-inventory.js";
import { userMayReach, userRoutes } from "../../server/http/route-access.js";

// Regex routes have no `:param` to fill in; each needs a path it matches here.
const regexProbes = {};
// Mounted ahead of the session check: a single-use OAuth state authenticates them.
const beforeLogin = [
  "GET /api/mcp-servers/oauth/callback",
  "HEAD /api/mcp-servers/oauth/callback",
  "GET /api/mcp-servers/cli-oauth/callback/:segment",
  "HEAD /api/mcp-servers/cli-oauth/callback/:segment",
];

// A direct local request reads the health without any session (requireLogin), so a
// local probe cannot show the refusal; tests/unit/route-access.test.js covers it.
const localPublic = ["GET /api/health", "HEAD /api/health"];

const probe = (route) => {
  if (route.regex) {
    const path = regexProbes[route.path];
    assert.ok(path, `regex route ${route.path} needs a probe in regexProbes`);
    return path;
  }
  assert.doesNotMatch(route.path, /[*{}()]/, `unsupported route syntax ${route.path}`);
  return route.path.replace(/:[A-Za-z0-9_]+/g, "probe");
};

async function usersFixture(t) {
  const f = await applicationFixture(t, enabledAssistants);
  const { cookie } = await signedInUser(f);
  const unknown = await f.request("/api/does-not-exist");
  assert.equal(unknown.status, 404);
  const as = (endpoint, method, extra = {}) =>
    f.request(endpoint, {
      method,
      headers: { cookie, ...extra },
      ...(["GET", "HEAD"].includes(method) ? {} : { body: {} }),
    });
  return { f, as, cookie, notFound: await unknown.json() };
}

test("users are denied every owner route in the registry", async (t) => {
  const { f, as, notFound } = await usersFixture(t);
  const routes = routeInventory(f.application);
  assert.deepEqual(
    routes
      .filter((r) => r.beforeLogin)
      .map((r) => `${r.method} ${r.path}`)
      .sort(),
    [...beforeLogin].sort(),
  );
  let probed = 0;
  for (const route of routes) {
    if (route.beforeLogin) continue;
    const method = route.method === "ALL" ? "GET" : route.method;
    const path = probe(route);
    if (userMayReach(method, path)) continue;
    if (localPublic.includes(`${method} ${route.path}`)) continue;
    const response = await as(path, method);
    const label = `${method} ${route.path}`;
    assert.equal(response.status, 404, label);
    assert.notEqual(response.headers.get("content-type"), "text/event-stream", label);
    if (method !== "HEAD") assert.deepEqual(await response.json(), notFound, label);
    probed++;
  }
  assert.ok(probed > 300, `probed ${probed} routes`);
});

test("every allow-list entry matches a real route", async (t) => {
  const { f } = await usersFixture(t);
  const routes = routeInventory(f.application).filter((r) => !r.regex);
  for (const { method, pattern } of userRoutes)
    assert.ok(
      routes.some((r) => r.method === method && pattern.test(probe(r))),
      `stale user route ${method} ${pattern}`,
    );
});

test("SSE streams are denied to users", async (t) => {
  const { as, notFound } = await usersFixture(t);
  for (const endpoint of ["/api/assistant-events", "/api/inbox/events"]) {
    const response = await as(endpoint, "GET", { accept: "text/event-stream" });
    assert.equal(response.status, 404, endpoint);
    assert.doesNotMatch(response.headers.get("content-type") || "", /event-stream/);
    assert.deepEqual(await response.json(), notFound, endpoint);
  }
});

test("a user reaches her own account routes", async (t) => {
  const { as, notFound } = await usersFixture(t);
  const me = await as("/api/me", "GET");
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.username, "Anna");
  for (const [method, endpoint] of [
    ["DELETE", "/api/me"],
    ["GET", "/api/me/password"],
    ["GET", "/api/me/whatever"],
  ]) {
    const response = await as(endpoint, method);
    assert.equal(response.status, 404, `${method} ${endpoint}`);
    assert.deepEqual(await response.json(), notFound);
  }
});

test("owner is denied /api/me", async (t) => {
  const { f, notFound } = await usersFixture(t);
  for (const [method, endpoint] of [
    ["GET", "/api/me"],
    ["PUT", "/api/me/password"],
  ]) {
    const response = await f.request(endpoint, {
      method,
      ...(method === "PUT" ? { body: {} } : {}),
    });
    assert.equal(response.status, 404, `${method} ${endpoint}`);
    assert.deepEqual(await response.json(), notFound);
  }
  assert.equal((await f.request("/api/state")).status, 200);
});
