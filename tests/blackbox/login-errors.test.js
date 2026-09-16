import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";

test("login failures carry stable identifiers while preserving status and throttling", async (t) => {
  const f = await applicationFixture(t, { authenticateFixture: false });
  const send = (action, body) =>
    fetch(`${f.url}/auth/${action}`, {
      method: "POST",
      headers: { origin: f.url, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  for (const [body, code] of [
    [{ username: "", password: "disposable-password" }, "LOGIN_USERNAME_INVALID"],
    [{ username: "owner", password: "short" }, "LOGIN_PASSWORD_INVALID"],
  ]) {
    const response = await send("setup", body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, code);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  const credentials = { username: "owner", password: "disposable-password" };
  assert.equal((await send("setup", credentials)).status, 201);
  const exists = await send("setup", credentials);
  assert.equal(exists.status, 409);
  assert.equal((await exists.json()).code, "LOGIN_ALREADY_CONFIGURED");
  const invalid = await send("login", { ...credentials, password: "wrong" });
  assert.equal(invalid.status, 401);
  assert.equal((await invalid.json()).code, "LOGIN_CREDENTIALS_INVALID");
  for (let i = 0; i < 9; i++) await send("login", {});
  const throttled = await send("login", {});
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get("retry-after"), "60");
  assert.equal((await throttled.json()).code, "LOGIN_THROTTLED");
});

test("unexpected login failures do not expose private diagnostics", async (t) => {
  const f = await applicationFixture(t);
  f.application.login.login = async () => {
    throw new Error("private-path-and-token");
  };
  const response = await fetch(`${f.url}/auth/login`, {
    method: "POST",
    headers: { origin: f.url, "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "wrong" }),
  });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.code, "LOGIN_FAILED");
  assert.equal(JSON.stringify(body).includes("private-path-and-token"), false);
});

test("login parser failures preserve client statuses without reflecting their bodies", async (t) => {
  const f = await applicationFixture(t);
  for (const [contentType, body, status] of [
    ["application/json", "private-malformed-body", 400],
    ["application/json", JSON.stringify({ password: "x".repeat(5000) }), 413],
    ["application/json; charset=unsupported", "{}", 415],
  ]) {
    const response = await fetch(`${f.url}/auth/login`, {
      method: "POST",
      headers: { origin: f.url, "content-type": contentType },
      body,
    });
    assert.equal(response.status, status);
    const result = await response.json();
    assert.equal(result.code, "LOGIN_FAILED");
    assert.equal(JSON.stringify(result).includes("private-malformed-body"), false);
  }
});
