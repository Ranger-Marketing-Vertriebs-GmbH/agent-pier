import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { applicationFixture } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";

// A session preview runs on another port of the same host: it receives the session
// cookie (cookies ignore ports), may plant one of its own, and is same-site to AgentPier.

async function freePort() {
  const server = net.createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// fetch() overrides Sec-Fetch-Mode, so navigations go through http.request.
function navigate(f, endpoint) {
  return new Promise((resolve, reject) => {
    const headers = {
      cookie: f.cookie,
      "sec-fetch-site": "same-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    };
    http
      .get(f.url + endpoint, { headers }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      })
      .on("error", reject);
  });
}

test("a planted cookie does not sign the owner out of HTTP or WebSocket", async (t) => {
  const f = await applicationFixture(t);
  for (const cookie of [
    `agentpier_session=planted; ${f.cookie}`,
    `${f.cookie}; agentpier_session=${"c".repeat(64)}`,
  ]) {
    assert.equal((await f.request("/api/remote", { headers: { cookie } })).status, 200);
    assert.equal((await f.request("/auth/status", { headers: { cookie } })).status, 200);
    const status = await (
      await f.request("/auth/status", { headers: { cookie } })
    ).json();
    assert.equal(status.authenticated, true);
    const live = openLive(f, cookie);
    await live.opened;
    live.ws.close();
    await live.closed;
  }
});

test("same-site requests from a sibling port are refused except navigations", async (t) => {
  const f = await applicationFixture(t);
  const sibling = `http://127.0.0.1:${await freePort()}`;
  const api = await f.request("/api/remote", {
    origin: null,
    headers: { "sec-fetch-site": "same-site", "sec-fetch-mode": "cors" },
  });
  assert.equal(api.status, 403);
  // Opening an AgentPier page from the preview passes the check (404 here only
  // because the fixture serves no built web app); navigating to the API does not.
  assert.notEqual(await navigate(f, "/"), 403);
  assert.equal(await navigate(f, "/api/remote"), 403);
  // AgentPier's own pages are same-origin and keep working.
  const own = await f.request("/api/remote", {
    headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" },
  });
  assert.equal(own.status, 200);
  const live = openLive(f, f.cookie, { origin: sibling });
  await assert.rejects(live.opened, (error) => error.statusCode === 403);
});
