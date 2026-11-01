import test from "node:test";
import assert from "node:assert/strict";
import {
  downstreamHeaders,
  upstreamHeaders,
  withoutSessionCookie,
} from "../../server/features/previews/preview-headers.js";
import {
  pageLanguage,
  previewPage,
} from "../../server/features/previews/preview-pages.js";

const req = (headers, remoteAddress = "127.0.0.1") => ({
  headers,
  socket: { remoteAddress },
});

test("the session cookie never reaches the app", () => {
  assert.equal(
    withoutSessionCookie("a=1; agentpier_session=x; b=2; agentpier_session=y"),
    "a=1; b=2",
  );
  assert.equal(withoutSessionCookie("agentpier_session=x"), null);
  assert.equal(withoutSessionCookie(undefined), null);
  assert.equal(
    withoutSessionCookie("agentpier_session_other=1"),
    "agentpier_session_other=1",
  );
});

test("upstream sees localhost:<target> and the forwarded origin", () => {
  const h = upstreamHeaders(
    req({
      host: "box.ts.net:47100",
      "tailscale-user-login": "o@x",
      origin: "https://box.ts.net:47100",
    }),
    { target: 5173, previewOrigin: "https://box.ts.net:47100" },
  );
  assert.equal(h.host, "localhost:5173");
  assert.equal(h.origin, "http://localhost:5173");
  assert.equal(h["x-forwarded-host"], "box.ts.net:47100");
  assert.equal(h["x-forwarded-proto"], "https");
  assert.equal(h["x-forwarded-for"], "127.0.0.1");
  assert.ok(!Object.keys(h).some((k) => k.startsWith("tailscale-")));
});

test("incoming forwarding headers are replaced and a foreign Origin stays", () => {
  const h = upstreamHeaders(
    req({
      host: "127.0.0.1:47100",
      forwarded: "for=evil",
      "x-forwarded-for": "6.6.6.6",
      "x-forwarded-host": "evil",
      origin: "http://elsewhere.test",
      referer: "http://127.0.0.1:47100/admin?x=1",
      cookie: "agentpier_session=secret; app=1",
      "content-type": "text/plain",
    }),
    { target: 3000, previewOrigin: "http://127.0.0.1:47100" },
  );
  assert.equal(h.forwarded, undefined);
  assert.equal(h["x-forwarded-for"], "127.0.0.1");
  assert.equal(h["x-forwarded-host"], "127.0.0.1:47100");
  assert.equal(h["x-forwarded-proto"], "http");
  assert.equal(h.origin, "http://elsewhere.test");
  assert.equal(h.referer, "http://localhost:3000/admin?x=1");
  assert.equal(h.cookie, "app=1");
  assert.equal(h["content-type"], "text/plain");
  const bare = upstreamHeaders(req({ cookie: "agentpier_session=secret" }), {
    target: 3000,
    previewOrigin: "http://127.0.0.1:47100",
  });
  assert.equal(Object.hasOwn(bare, "cookie"), false);
});

test("Location rewrite and Set-Cookie filter", () => {
  const h = downstreamHeaders(
    {
      location: "http://localhost:5173/admin?x=1",
      "set-cookie": ["agentpier_session=evil; Path=/", "app=1"],
    },
    { target: 5173, previewOrigin: "http://127.0.0.1:47100" },
  );
  assert.equal(h.location, "http://127.0.0.1:47100/admin?x=1");
  assert.deepEqual(h["set-cookie"], ["app=1"]);
  for (const [location, expected] of [
    ["http://127.0.0.1:5173", "http://127.0.0.1:47100"],
    ["http://[::1]:5173/x", "http://127.0.0.1:47100/x"],
    ["http://localhost:51730/x", "http://localhost:51730/x"],
    ["/relative", "/relative"],
    ["https://example.com/", "https://example.com/"],
  ])
    assert.equal(
      downstreamHeaders(
        { location },
        { target: 5173, previewOrigin: "http://127.0.0.1:47100" },
      ).location,
      expected,
      location,
    );
  const only = downstreamHeaders(
    { "set-cookie": [" agentpier_session=evil"] },
    { target: 5173, previewOrigin: "http://127.0.0.1:47100" },
  );
  assert.equal(Object.hasOwn(only, "set-cookie"), false);
});

test("pages are localized, carry their status and escape the label", () => {
  const unreachable = previewPage("unreachable", {
    language: "en",
    label: `<script>alert(1)</script>`,
    target: 5173,
  });
  assert.equal(unreachable.status, 502);
  assert.match(unreachable.html, /The server on port 5173 is not answering/);
  assert.ok(!unreachable.html.includes("<script>alert"));
  assert.match(unreachable.html, /&lt;script&gt;/);
  assert.equal(previewPage("idle", { language: "de" }).status, 404);
  assert.equal(previewPage("forbidden", { language: "en" }).status, 403);
  const signIn = previewPage("signIn", {
    language: "en",
    signInUrl: "http://localhost:4380/?preview=47100&path=%2F",
  });
  assert.equal(signIn.status, 401);
  assert.match(
    signIn.html,
    /href="http:\/\/localhost:4380\/\?preview=47100&amp;path=%2F"/,
  );
  const bounce = previewPage("bounce", { language: "en" });
  assert.equal(bounce.status, 200);
  assert.match(bounce.html, /location\.replace\(location\.href\)/);
  assert.notEqual(
    previewPage("idle", { language: "de" }).html,
    previewPage("idle", { language: "en" }).html,
  );
});

test("the page language follows Accept-Language", () => {
  assert.equal(pageLanguage(req({ "accept-language": "de-DE,de;q=0.9" })), "de");
  assert.equal(pageLanguage(req({ "accept-language": "en-US,de;q=0.5" })), "en");
  assert.equal(pageLanguage(req({})), "en");
});

test("hop-by-hop headers and those named in Connection are dropped both ways", () => {
  const options = { target: 5173, previewOrigin: "http://127.0.0.1:47100" };
  const up = upstreamHeaders(
    req({
      host: "127.0.0.1:47100",
      connection: "keep-alive, X-Secret",
      "x-secret": "1",
      te: "trailers",
      "proxy-authorization": "Basic x",
      "x-app": "1",
    }),
    options,
  );
  for (const name of ["connection", "x-secret", "te", "proxy-authorization"])
    assert.equal(up[name], undefined, name);
  assert.equal(up["x-app"], "1");
  const down = downstreamHeaders(
    {
      connection: "close, x-private",
      "x-private": "1",
      upgrade: "h2c",
      trailer: "x-sum",
      "proxy-authenticate": "Basic",
      "keep-alive": "timeout=5",
      "x-app": "1",
    },
    options,
  );
  assert.deepEqual(down, { "x-app": "1" });
});

test("a chunked request body stays chunked upstream; a sized one keeps its length", () => {
  const options = { target: 5173, previewOrigin: "http://127.0.0.1:47100" };
  const chunked = upstreamHeaders(
    req({ host: "127.0.0.1:47100", "transfer-encoding": "gzip, chunked" }),
    options,
  );
  assert.equal(chunked["transfer-encoding"], "chunked");
  const sized = upstreamHeaders(
    req({ host: "127.0.0.1:47100", "content-length": "5" }),
    options,
  );
  assert.equal(sized["transfer-encoding"], undefined);
  assert.equal(sized["content-length"], "5");
});
