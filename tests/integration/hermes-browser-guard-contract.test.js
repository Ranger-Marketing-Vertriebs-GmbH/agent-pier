import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { hermesContractBrowser } from "../helpers/hermes-native.js";
import { HermesBrowser } from "../../server/features/assistants/runtimes/hermes/hermes-browser.js";

// AgentPier's navigation guard (hermes-browser-guard.js) on a real Chromium, the
// browser app of the Hermes browser contracts: the ways a page or the agent's own
// CDP calls reach a private or metadata address besides a plain navigation. The test
// names resolve to the local server inside Chromium (--host-resolver-rules) while the
// guard's own lookup sees `public.test` as a public address, as a rebinding name would.
const contractBrowser = hermesContractBrowser();
const options = { skip: contractBrowser.skip, timeout: contractTimeout(300000) };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function server(t) {
  const hits = [];
  const page = http.createServer((req, res) => {
    hits.push(req.url);
    const port = page.address().port;
    if (req.url === "/redirect") {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` });
      return res.end();
    }
    if (req.url === "/redirect-metadata") {
      res.writeHead(302, { location: `http://metadata.google.internal:${port}/secret` });
      return res.end();
    }
    if (req.url === "/sw.js") {
      res.setHeader("content-type", "text/javascript");
      return res.end(
        `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (new URL(e.request.url).pathname === "/proxied")
    e.respondWith(fetch("http://metadata.google.internal:${port}/secret").catch(() => new Response("<title>refused</title>", { headers: { "content-type": "text/html" } })));
});`,
      );
    }
    if (req.url === "/sw-page") {
      res.setHeader("content-type", "text/html");
      return res.end(
        `<title>sw</title><script>navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready).then(() => { document.title = "ready"; });</script>`,
      );
    }
    res.setHeader("content-type", "text/html");
    res.end(`<title>${req.url === "/secret" ? "SECRET" : "page"}</title>`);
  });
  await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve));
  t.after(() => page.close());
  return { port: page.address().port, hits };
}

async function launch(t, { allowPrivateNetwork, port }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-guard-contract-"));
  const browser = new HermesBrowser({
    directory,
    settings: () => ({
      executablePath: contractBrowser.browser.executablePath,
      headless: true,
      allowPrivateNetwork,
    }),
    args: [
      `--host-resolver-rules=MAP public.test 127.0.0.1, MAP metadata.google.internal 127.0.0.1`,
      `--unsafely-treat-insecure-origin-as-secure=http://public.test:${port}`,
    ],
    lookup: async (host) =>
      host === "public.test"
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }],
  });
  t.after(async () => {
    await browser.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await browser.start();
  return browser;
}

// One CDP session on the browser's own socket, as an agent's browser_cdp or
// browser_exec would hold.
async function cdp(t, browser) {
  const ws = new WebSocket((await browser.version()).webSocketDebuggerUrl);
  await new Promise((resolve) => (ws.onopen = resolve));
  t.after(() => ws.close());
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    waiting.get(message.id)?.(message);
  };
  return (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId && { sessionId }) }));
    });
}
const pages = async (browser) =>
  (await browser.tabs()).filter((tab) => tab.type === "page");

test(
  "Hermes contract: the navigation guard holds redirects, new contexts, page requests and rebinding",
  options,
  async (t) => {
    const { port, hits } = await server(t);
    const browser = await launch(t, { allowPrivateNetwork: false, port });
    const call = await cdp(t, browser);
    const secret = () => hits.filter((url) => url === "/secret").length;

    // A public page that redirects to a private address: the redirect is refused.
    await call("Target.createTarget", { url: `http://public.test:${port}/redirect` });
    await sleep(1500);
    assert.equal(secret(), 0, "a redirect reached the private address");

    // A tab in a new browser context.
    const context = await call("Target.createBrowserContext");
    await call("Target.createTarget", {
      url: `http://127.0.0.1:${port}/secret`,
      browserContextId: context.result.browserContextId,
    });
    await sleep(1000);
    assert.equal(secret(), 0, "a new browser context reached the private address");

    // A page's own fetch() (Runtime.evaluate, as browser_exec's js() runs it).
    const blank = await call("Target.createTarget", { url: "about:blank" });
    const session = (
      await call("Target.attachToTarget", {
        targetId: blank.result.targetId,
        flatten: true,
      })
    ).result.sessionId;
    const fetched = await call(
      "Runtime.evaluate",
      {
        expression: `fetch("http://127.0.0.1:${port}/secret").then(() => "read", () => "refused")`,
        awaitPromise: true,
      },
      session,
    );
    assert.equal(fetched.result.result.value, "refused");
    assert.equal(secret(), 0, "a page's fetch reached the private address");

    // A name the guard resolved as public whose answer came from a private address
    // (DNS rebinding): the page is closed.
    const rebound = await call("Target.createTarget", {
      url: `http://public.test:${port}/`,
    });
    await sleep(1500);
    assert.equal(
      (await pages(browser)).some((tab) => tab.targetId === rebound.result.targetId),
      false,
      "the rebound page stayed open",
    );

    // A file: page and a browser page.
    const file = await call("Target.createTarget", { url: "file:///etc/hosts" });
    const settings = await call("Target.createTarget", { url: "chrome://version" });
    await sleep(1000);
    const open = await pages(browser);
    const fileTab = open.find((tab) => tab.targetId === file.result.targetId);
    assert.ok(!fileTab || !/localhost/.test(fileTab.title), "file: page shown");
    assert.equal(
      open.some((tab) => tab.targetId === settings.result.targetId),
      false,
      "a browser page stayed open",
    );
  },
);

test(
  "Hermes contract: with private networks allowed, metadata stays out of redirects and service workers",
  options,
  async (t) => {
    const { port, hits } = await server(t);
    const browser = await launch(t, { allowPrivateNetwork: true, port });
    const call = await cdp(t, browser);
    const secret = () => hits.filter((url) => url === "/secret").length;

    await call("Target.createTarget", {
      url: `http://127.0.0.1:${port}/redirect-metadata`,
    });
    await sleep(1500);
    assert.equal(secret(), 0, "a redirect reached a metadata name");

    // A service worker answers a navigation with a fetch of its own.
    const tab = await call("Target.createTarget", {
      url: `http://127.0.0.1:${port}/sw-page`,
    });
    const session = (
      await call("Target.attachToTarget", {
        targetId: tab.result.targetId,
        flatten: true,
      })
    ).result.sessionId;
    for (let n = 0; n < 40; n++) {
      const title = await call(
        "Runtime.evaluate",
        { expression: "document.title" },
        session,
      );
      if (title.result?.result?.value === "ready") break;
      await sleep(250);
    }
    await call("Page.navigate", { url: `http://127.0.0.1:${port}/proxied` }, session);
    await sleep(1500);
    assert.ok(hits.includes("/sw.js"), "the service worker never registered");
    assert.equal(secret(), 0, "a service worker's fetch reached a metadata name");
  },
);
