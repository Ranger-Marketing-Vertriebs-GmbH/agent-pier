import test from "node:test";
import assert from "node:assert/strict";
import {
  routeAccess,
  userMayReach,
  userMayWatch,
  userRoutes,
  userTopics,
} from "../../server/http/route-access.js";
import { liveGate } from "../../server/application/live-wiring.js";

const decide = (principal, method, path) => {
  let status = null;
  const res = { status: (code) => ((status = code), { json: () => {} }) };
  let passed = false;
  routeAccess()({ principal, method, baseUrl: "/api", path }, res, () => (passed = true));
  return passed ? "next" : status;
};

test("users reach only their own /api/me routes", () => {
  assert.equal(userMayReach("GET", "/api/me"), true);
  assert.equal(userMayReach("HEAD", "/api/me"), true);
  assert.equal(userMayReach("PUT", "/api/me/password"), true);
  assert.equal(userMayReach("GET", "/api/meetings"), false);
  assert.equal(userMayReach("DELETE", "/api/me"), false);
  assert.equal(userMayReach("GET", "/api/me/../assistants"), false);
  assert.equal(userMayReach("GET", "/api/me/%2e%2e/assistants"), false);
  assert.equal(userMayReach("GET", "/api/assistants"), false);
  assert.equal(userMayReach("GET", "/me"), false);
});

test("every allow-list entry stays inside /api/me", () => {
  for (const { method, pattern } of userRoutes) {
    assert.match(method, /^(?:GET|POST|PUT|PATCH|DELETE)$/);
    assert.match(pattern.source, /^\^\\\/api\\\/me(?:\$|\\\/)/, pattern.source);
    assert.ok(pattern.source.endsWith("$"), pattern.source);
  }
});

test("the middleware refuses users outside /api/me and the owner inside it", () => {
  const user = { role: "user", userId: "u1" };
  assert.equal(decide(user, "GET", "/me"), "next");
  assert.equal(decide(user, "GET", "/health"), 404);
  assert.equal(decide(user, "GET", "/assistants"), 404);
  assert.equal(decide({ role: "owner" }, "GET", "/health"), "next");
  assert.equal(decide({ role: "owner" }, "GET", "/me"), 404);
  assert.equal(decide({ role: "owner" }, "PUT", "/me/password"), 404);
  // A local health check carries no principal and is no /me route.
  assert.equal(decide(undefined, "GET", "/health"), "next");
  assert.equal(decide(undefined, "GET", "/me"), 404);
});

test("users watch only me.* live topics, none of them yet", () => {
  for (const pattern of userTopics) assert.match(pattern.source, /^\^me\\\./);
  assert.equal(userTopics.length, 0);
  for (const topic of ["state", "me", "inbox", "session.requests:x", 7, null])
    assert.equal(userMayWatch(topic), false);
});

test("the live gate admits the owner and users only through userTopics", () => {
  assert.equal(liveGate({ role: "owner" }, "state"), true);
  assert.equal(liveGate({ role: "user", userId: "u" }, "state"), false);
  assert.equal(liveGate(undefined, "state"), false);
  assert.equal(liveGate({ role: "guest" }, "state"), false);
  userTopics.push(/^me\.counts$/);
  try {
    assert.equal(liveGate({ role: "user", userId: "u" }, "me.counts"), true);
    assert.equal(userMayWatch("me.counts".padEnd(201, "x")), false);
  } finally {
    userTopics.pop();
  }
});
