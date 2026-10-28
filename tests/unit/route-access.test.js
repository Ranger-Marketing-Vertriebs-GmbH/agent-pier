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
import { AGENT_PARAM } from "../../server/features/assistants/live-topics.js";

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
  // Her former event stream is gone: her app follows the me.* live topics.
  assert.equal(userMayReach("GET", "/api/me/events"), false);
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

test("users watch only the me.* live topics of their GET routes", () => {
  for (const pattern of userTopics) assert.match(pattern.source, /^\^me\\\./);
  assert.equal(userTopics.length, 6);
  for (const route of userRoutes.filter((r) => r.topic))
    assert.equal(route.method, "GET");
  for (const topic of [
    "me.agents",
    "me.account",
    "me.approvals",
    "me.chats:a-1",
    "me.telegram:a_1",
    "me.reminders:A1",
  ])
    assert.equal(userMayWatch(topic), true, topic);
  for (const topic of [
    "state",
    "me",
    "inbox",
    "session.requests:x",
    "me.chats",
    "me.chats:",
    "me.chats:a/b",
    "me.chats:a:b",
    "me.chats:-a",
    "me.agents:x",
    "me.routines:x",
    "me.events",
    `me.chats:${"a".repeat(101)}`,
    7,
    null,
  ])
    assert.equal(userMayWatch(topic), false, String(topic));
  // The topic's agent id is the hub's (assistants/live-topics.js AGENT_PARAM).
  assert.ok(userTopics.some((p) => p.source.includes(AGENT_PARAM.source)));
});

test("the live gate admits the owner and users only through userTopics", () => {
  assert.equal(liveGate({ role: "owner" }, "state"), true);
  assert.equal(liveGate({ role: "user", userId: "u" }, "state"), false);
  assert.equal(liveGate(undefined, "state"), false);
  assert.equal(liveGate({ role: "guest" }, "state"), false);
  assert.ok(Object.isFrozen(userTopics));
  const topics = [/^me\.counts$/, /^me\.c.*$/];
  assert.equal(liveGate({ role: "user", userId: "u" }, "me.counts", topics), true);
  assert.equal(liveGate({ role: "owner" }, "me.counts", []), true);
  assert.equal(userMayWatch("me.c".padEnd(201, "x"), topics), false);
});
