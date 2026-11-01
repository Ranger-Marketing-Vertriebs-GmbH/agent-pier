import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { previews as de } from "../../server/lib/i18n/de/previews.js";
import {
  agentPierPort,
  openSocket,
  previewFixture,
  send,
  startUpstream,
} from "../helpers/preview-proxy-fixture.js";

const navigate = (site) => ({
  "sec-fetch-site": site,
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
});

test("forwards method, path, query, body and streams SSE unbuffered", async (t) => {
  let release;
  const released = new Promise((resolve) => (release = resolve));
  const upstream = await startUpstream(t, {
    handler: (req, res) => {
      if (req.url !== "/events") {
        res.writeHead(201, { "content-type": "text/plain", "x-app": "1" });
        return res.end(`${req.method} ${req.url}`);
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      released.then(() => res.end("data: last\n\n"));
    },
  });
  const f = await previewFixture(t, { upstream });
  const answer = await send(f.slot, {
    method: "POST",
    path: "/api/items?x=1&y=2",
    headers: {
      host: f.host,
      cookie: f.owner,
      origin: `http://${f.host}`,
      "content-type": "text/plain",
    },
    body: "hello",
  });
  assert.equal(answer.status, 201);
  assert.equal(answer.body, "POST /api/items?x=1&y=2");
  assert.equal(answer.headers["x-app"], "1");
  assert.equal(answer.headers["content-security-policy"], undefined);
  assert.equal(answer.headers["x-frame-options"], undefined);
  const seen = upstream.seen.at(-1);
  assert.equal(seen.body, "hello");
  assert.equal(seen.headers.origin, `http://localhost:${upstream.port}`);
  assert.equal(f.state.touched, 1);

  const req = http.request({
    host: "127.0.0.1",
    port: f.slot,
    path: "/events",
    headers: { host: f.host, cookie: f.owner },
    agent: false,
  });
  req.end();
  const [res] = await once(req, "response");
  const [first] = await once(res, "data");
  assert.match(first.toString(), /data: first/);
  release();
  let rest = "";
  for await (const chunk of res) rest += chunk;
  assert.match(rest, /data: last/);
});

test("pipes a WebSocket upgrade both ways", async (t) => {
  const upstream = await startUpstream(t);
  const f = await previewFixture(t, { upstream });
  const socket = await openSocket(f.slot, {
    host: f.host,
    cookie: f.owner,
    origin: `http://${f.host}`,
  });
  socket.send("ping");
  const [data] = await once(socket, "message");
  assert.equal(data.toString(), "echo:ping");
  socket.close();
  const upgrade = upstream.seen.find((entry) => entry.upgrade);
  assert.equal(upgrade.url, "/hmr");
  assert.equal(upgrade.headers.host, `localhost:${upstream.port}`);
  assert.equal(upgrade.headers.origin, `http://localhost:${upstream.port}`);
  assert.equal(upgrade.headers.cookie, undefined);
});

test("forwards to ::1 when the target listens only there", async (t) => {
  let upstream;
  try {
    upstream = await startUpstream(t, { host: "::1" });
  } catch {
    return t.skip("IPv6 loopback is not available");
  }
  const f = await previewFixture(t, { upstream, address: "::1" });
  const answer = await send(f.slot, { headers: { host: f.host, cookie: f.owner } });
  assert.equal(answer.status, 200);
  assert.equal(answer.body, "GET / ");
});

test("refuses without an owner session; a cross-site navigation gets the bounce page", async (t) => {
  const upstream = await startUpstream(t);
  const f = await previewFixture(t, { upstream });
  const bounce = await send(f.slot, {
    path: "/admin?x=1",
    headers: { host: f.host, ...navigate("cross-site") },
  });
  assert.equal(bounce.status, 401);
  assert.match(bounce.body, /location\.replace\(location\.href\)/);
  const signIn = await send(f.slot, {
    path: "/admin?x=1",
    headers: {
      host: f.host,
      cookie: "agentpier_session=forged",
      ...navigate("same-origin"),
    },
  });
  assert.equal(signIn.status, 401);
  assert.ok(
    signIn.body.includes(
      `http://127.0.0.1:${agentPierPort}/?preview=${f.slot}&amp;path=%2Fadmin%3Fx%3D1`,
    ),
  );
  assert.doesNotMatch(signIn.body, /location\.replace/);
  const sub = await send(f.slot, {
    path: "/api",
    headers: { host: f.host, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" },
  });
  assert.equal(sub.status, 401);
  assert.doesNotMatch(sub.body, /<html/);
  await assert.rejects(openSocket(f.slot, { host: f.host }), { status: 401 });
  assert.equal(upstream.seen.length, 0);
  assert.equal(f.state.touched, 0);
});

test("signInUrl uses the request host name", async (t) => {
  const upstream = await startUpstream(t);
  const f = await previewFixture(t, { upstream });
  const answer = await send(f.slot, {
    headers: { host: `localhost:${f.slot}`, ...navigate("none") },
  });
  assert.equal(answer.status, 401);
  assert.ok(
    answer.body.includes(
      `http://localhost:${agentPierPort}/?preview=${f.slot}&amp;path=%2F`,
    ),
  );
});

test("a restricted user's session is refused with the forbidden page", async (t) => {
  const upstream = await startUpstream(t);
  const f = await previewFixture(t, { upstream });
  const answer = await send(f.slot, {
    headers: {
      host: f.host,
      cookie: "agentpier_session=user-token",
      ...navigate("same-origin"),
    },
  });
  assert.equal(answer.status, 403);
  assert.match(answer.body, /<html/);
  await assert.rejects(
    openSocket(f.slot, { host: f.host, cookie: "agentpier_session=user-token" }),
    { status: 403 },
  );
  assert.equal(upstream.seen.length, 0);
});

test("wrong Host, tailscale markers on the local branch, or Tailscale without identity → 403", async (t) => {
  const upstream = await startUpstream(t);
  const f = await previewFixture(t, {
    upstream,
    config: { remoteUrl: "https://box.tail.ts.net" },
  });
  const status = async (headers) =>
    (await send(f.slot, { headers: { cookie: f.owner, ...headers } })).status;
  assert.equal(await status({ host: "evil.test:" + f.slot }), 403);
  assert.equal(await status({ host: `127.0.0.1:${agentPierPort}` }), 403);
  assert.equal(await status({ host: f.host, "tailscale-user-login": "o@x" }), 403);
  assert.equal(await status({ host: f.host, "x-forwarded-for": "1.2.3.4" }), 403);
  assert.equal(await status({ host: f.host, forwarded: "for=1.2.3.4" }), 403);
  assert.equal(await status({ host: `box.tail.ts.net:${f.slot}` }), 403);
  assert.equal(
    await status({ host: `box.tail.ts.net:${f.slot}`, "tailscale-user-login": " " }),
    403,
  );
  assert.equal(
    await status({ host: `box.tail.ts.net:${f.slot}`, "tailscale-user-login": "o@x" }),
    200,
  );
  // Network hosts are refused while network mode is off.
  assert.equal(await status({ host: `192.168.1.5:${f.slot}` }), 403);
  const tailnet = await send(f.slot, {
    headers: {
      host: `box.tail.ts.net:${f.slot}`,
      "tailscale-user-login": "o@x",
      ...navigate("none"),
    },
  });
  assert.ok(
    tailnet.body.includes(`https://box.tail.ts.net/?preview=${f.slot}&amp;path=%2F`),
  );
  assert.equal(upstream.seen.length, 1);
});

test("network mode accepts a configured network host with the slot port and refuses tailscale headers there", async (t) => {
  const upstream = await startUpstream(t);
  const f = await previewFixture(t, {
    upstream,
    config: { network: { enabled: true, bind: "0.0.0.0", hosts: ["devbox.lan"] } },
    detected: { addresses: ["192.168.1.5"], hostname: "devbox" },
  });
  const status = async (headers) =>
    (await send(f.slot, { headers: { cookie: f.owner, ...headers } })).status;
  assert.equal(await status({ host: `devbox.lan:${f.slot}` }), 200);
  assert.equal(await status({ host: `192.168.1.5:${f.slot}` }), 200);
  assert.equal(await status({ host: `devbox.local:${f.slot}` }), 200);
  assert.equal(await status({ host: `devbox.lan:${agentPierPort}` }), 403);
  assert.equal(await status({ host: `other.lan:${f.slot}` }), 403);
  assert.equal(
    await status({ host: `devbox.lan:${f.slot}`, "tailscale-user-login": "o@x" }),
    403,
  );
  const signIn = await send(f.slot, {
    headers: { host: `devbox.lan:${f.slot}`, ...navigate("same-origin") },
  });
  assert.ok(
    signIn.body.includes(`http://devbox.lan:${agentPierPort}/?preview=${f.slot}`),
  );
});

test("unreachable upstream answers 502 and recovers", async (t) => {
  const upstream = await startUpstream(t);
  const f = await previewFixture(t, { upstream });
  await upstream.close();
  const headers = { host: f.host, cookie: f.owner, "accept-language": "en-US" };
  const down = await send(f.slot, { headers });
  assert.equal(down.status, 502);
  assert.ok(down.body.includes(`The server on port ${upstream.port} is not answering`));
  assert.ok(down.body.includes("Shop &lt;b&gt;"));
  await startUpstream(t, { port: upstream.port });
  assert.equal((await send(f.slot, { headers })).status, 200);
});

test("revoking the owner session closes proxied sockets", async (t) => {
  const upstream = await startUpstream(t, {
    handler: (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: open\n\n");
    },
  });
  const f = await previewFixture(t, { upstream });
  const socket = await openSocket(f.slot, { host: f.host, cookie: f.owner });
  const req = http.request({
    host: "127.0.0.1",
    port: f.slot,
    path: "/events",
    headers: { host: f.host, cookie: f.owner },
    agent: false,
  });
  req.on("error", () => {});
  req.end();
  const [res] = await once(req, "response");
  await once(res, "data");
  // The response is cut off: it ends in an "aborted" error, then closes.
  res.on("error", () => {});
  const closed = once(socket, "close");
  const ended = new Promise((resolve) => res.once("close", resolve));
  f.store.revoke(f.token);
  await closed;
  await ended;
  const after = await send(f.slot, { headers: { host: f.host, cookie: f.owner } });
  assert.equal(after.status, 401);
});

test("an idle slot answers the localized no-preview page", async (t) => {
  const upstream = await startUpstream(t);
  const f = await previewFixture(t, { upstream });
  f.state.alive = false;
  const answer = await send(f.slot, {
    headers: { host: f.host, cookie: f.owner, "accept-language": "de-DE,de;q=0.9" },
  });
  assert.equal(answer.status, 404);
  assert.ok(answer.body.includes(de.pages.idleTitle));
  assert.match(answer.body, /<html lang="de"/);
  await assert.rejects(openSocket(f.slot, { host: f.host, cookie: f.owner }), {
    status: 404,
  });
  assert.equal(upstream.seen.length, 0);
});

test("the agentpier_session cookie and tailscale headers never reach the upstream", async (t) => {
  const upstream = await startUpstream(t, {
    handler: (req, res) => {
      res.writeHead(302, {
        location: `http://localhost:${req.headers.host.split(":")[1]}/next`,
        "set-cookie": ["agentpier_session=planted; Path=/", "app=1; Path=/"],
      });
      res.end();
    },
  });
  upstream.wss.on("headers", (lines) =>
    lines.push("Set-Cookie: agentpier_session=planted", "Set-Cookie: app=2"),
  );
  const f = await previewFixture(t, {
    upstream,
    config: { remoteUrl: "https://box.tail.ts.net" },
  });
  const host = `box.tail.ts.net:${f.slot}`;
  const tailnet = {
    host,
    cookie: `app=1; ${f.owner}; agentpier_session=other`,
    "tailscale-user-login": "o@x",
    "tailscale-user-name": "Owner",
    "x-forwarded-for": "100.64.0.9",
  };
  const answer = await send(f.slot, { headers: tailnet });
  assert.equal(answer.status, 302);
  assert.equal(answer.headers.location, `https://${host}/next`);
  assert.deepEqual(answer.headers["set-cookie"], ["app=1; Path=/"]);
  const socket = await openSocket(f.slot, { ...tailnet, origin: `https://${host}` });
  assert.deepEqual(socket.handshake["set-cookie"], ["app=2"]);
  socket.close();
  for (const seen of upstream.seen) {
    assert.equal(seen.headers.cookie, "app=1");
    assert.ok(!Object.keys(seen.headers).some((key) => key.startsWith("tailscale-")));
    assert.equal(seen.headers.host, `localhost:${upstream.port}`);
    assert.equal(seen.headers["x-forwarded-proto"], "https");
    assert.equal(seen.headers["x-forwarded-host"], host);
    assert.equal(seen.headers["x-forwarded-for"], "127.0.0.1");
  }
  assert.equal(upstream.seen.length, 2);
  assert.equal(upstream.seen[1].headers.origin, `http://localhost:${upstream.port}`);
});
