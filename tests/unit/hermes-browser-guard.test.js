import test from "node:test";
import assert from "node:assert/strict";
import {
  NavigationGuard,
  documentAllowed,
} from "../../server/features/assistants/runtimes/hermes/hermes-browser-guard.js";
import {
  navigationAllowed,
  privateAddress,
} from "../../server/features/assistants/browser-navigation.js";

// AgentPier's navigation guard on a Hermes agent's Chromium (hermes-browser-guard.js),
// AGENTPIER-479 review: addresses written as IPv6 forms of an IPv4 address, failed
// lookups, non-web documents, browser pages, and an address the browser reached
// after the guard's own lookup (DNS rebinding).

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("IPv6 forms of a private or metadata IPv4 address count as that address", async () => {
  for (const address of [
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::7f00:1",
    "::127.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b::10.0.0.5",
    "64:ff9b:1::a9fe:a9fe",
    "::ffff:169.254.169.254",
  ])
    assert.equal(privateAddress(address), true, address);
  for (const address of ["::ffff:93.184.216.34", "64:ff9b::5db8:d822", "2606:4700::1"])
    assert.equal(privateAddress(address), false, address);
  for (const url of [
    "http://[::ffff:169.254.169.254]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://[::a9fe:a9fe]/",
    "http://[fd00:ec2::254]/",
    "http://100.100.100.200/",
  ])
    assert.equal(
      await documentAllowed(url, { allowPrivateNetwork: true, lookup: publicLookup }),
      false,
      url,
    );
  for (const url of ["http://[::7f00:1]/", "http://[::ffff:10.0.0.5]/"]) {
    assert.equal(await documentAllowed(url, { lookup: publicLookup }), false, url);
    assert.equal(await navigationAllowed(url, { lookup: publicLookup }), false, url);
  }
});

test("a failed lookup refuses, and only web addresses load", async () => {
  const failing = async () => {
    throw Object.assign(Error("ENOTFOUND"), { code: "ENOTFOUND" });
  };
  for (const allowPrivateNetwork of [false, true])
    assert.equal(
      await documentAllowed("http://nas.example/", {
        allowPrivateNetwork,
        lookup: failing,
      }),
      false,
    );
  for (const url of ["file:///etc/hosts", "filesystem:http://a.example/x"])
    assert.equal(
      await documentAllowed(url, { allowPrivateNetwork: true, lookup: publicLookup }),
      false,
      url,
    );
  assert.equal(
    await documentAllowed("https://a.example/", { lookup: publicLookup }),
    true,
  );
});

// A browser socket that answers every command and lets the test push events.
function fakeBrowser() {
  const sockets = [];
  class Socket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.sent = [];
      sockets.push(this);
      setImmediate(() => this.onopen?.());
    }
    send(text) {
      const message = JSON.parse(text);
      this.sent.push(message);
      setImmediate(() =>
        this.onmessage?.({
          data: JSON.stringify({
            id: message.id,
            result: {},
            ...(message.sessionId && { sessionId: message.sessionId }),
          }),
        }),
      );
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    event(method, params, sessionId) {
      this.onmessage({ data: JSON.stringify({ method, params, sessionId }) });
    }
  }
  return { Socket, sockets };
}
const settle = async (socket, before) => {
  for (let n = 0; n < 20 && socket.sent.length === before; n++)
    await new Promise((resolve) => setImmediate(resolve));
};

test("the guard intercepts every request and watches pages, frames and their answers", async () => {
  const { Socket, sockets } = fakeBrowser();
  const guard = new NavigationGuard({
    socketUrl: "ws://127.0.0.1:1/devtools/browser/b",
    WebSocketImpl: Socket,
    lookup: publicLookup,
  });
  await guard.start();
  const [socket] = sockets;
  const methods = socket.sent.map((m) => m.method);
  assert.deepEqual(methods.slice(0, 3), [
    "Fetch.enable",
    "Target.setDiscoverTargets",
    "Target.setAutoAttach",
  ]);
  assert.deepEqual(socket.sent[0].params, {
    patterns: [{ urlPattern: "*", requestStage: "Request" }],
  });
  // A page or frame gets the network watch before it runs.
  let before = socket.sent.length;
  socket.event("Target.attachedToTarget", {
    sessionId: "S1",
    targetInfo: { targetId: "T1", type: "page", url: "about:blank" },
    waitingForDebugger: true,
  });
  await settle(socket, before);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(
    socket.sent.slice(before).map((m) => [m.method, m.sessionId]),
    [
      ["Network.enable", "S1"],
      ["Target.setAutoAttach", "S1"],
      ["Runtime.runIfWaitingForDebugger", "S1"],
    ],
  );
  // An answer from a private address after the guard's own lookup said otherwise
  // (DNS rebinding) closes the page.
  before = socket.sent.length;
  socket.event(
    "Network.responseReceived",
    {
      type: "Fetch",
      response: { url: "http://rebind.example/", remoteIPAddress: "127.0.0.1" },
    },
    "S1",
  );
  await settle(socket, before);
  assert.deepEqual(socket.sent.at(-1).method, "Target.closeTarget");
  assert.deepEqual(socket.sent.at(-1).params, { targetId: "T1" });
  // A public answer, or one without an address (cache, service worker), stays.
  before = socket.sent.length;
  for (const remoteIPAddress of ["93.184.216.34", "", undefined])
    socket.event(
      "Network.responseReceived",
      { type: "Document", response: { url: "https://a.example/", remoteIPAddress } },
      "S1",
    );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(socket.sent.length, before);
  // A browser page (chrome:, devtools:) is closed; a new tab page stays.
  before = socket.sent.length;
  socket.event("Target.targetInfoChanged", {
    targetInfo: { targetId: "T2", type: "page", url: "chrome://settings/" },
  });
  socket.event("Target.targetCreated", {
    targetInfo: { targetId: "T3", type: "page", url: "devtools://devtools/x" },
  });
  socket.event("Target.targetInfoChanged", {
    targetInfo: { targetId: "T4", type: "page", url: "chrome://newtab/" },
  });
  socket.event("Target.targetInfoChanged", {
    targetInfo: {
      targetId: "W1",
      type: "service_worker",
      url: "chrome-extension://x/sw.js",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(
    socket.sent.slice(before).map((m) => [m.method, m.params.targetId]),
    [
      ["Target.closeTarget", "T2"],
      ["Target.closeTarget", "T3"],
    ],
  );
  // A file: request is refused whatever the setting.
  before = socket.sent.length;
  socket.event("Fetch.requestPaused", {
    requestId: "r1",
    request: { url: "file:///etc/hosts" },
  });
  await settle(socket, before);
  assert.equal(socket.sent.at(-1).method, "Fetch.failRequest");
  guard.close();
});

test("with private networks allowed only a metadata answer closes the page", async () => {
  const { Socket, sockets } = fakeBrowser();
  const guard = new NavigationGuard({
    socketUrl: "ws://127.0.0.1:1/devtools/browser/b",
    allowPrivateNetwork: true,
    WebSocketImpl: Socket,
    lookup: publicLookup,
  });
  await guard.start();
  const [socket] = sockets;
  socket.event("Target.attachedToTarget", {
    sessionId: "S1",
    targetInfo: { targetId: "T1", type: "page", url: "about:blank" },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  let before = socket.sent.length;
  socket.event(
    "Network.responseReceived",
    { type: "Document", response: { remoteIPAddress: "10.0.0.5" } },
    "S1",
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(socket.sent.length, before);
  socket.event(
    "Network.responseReceived",
    { type: "Document", response: { remoteIPAddress: "::ffff:169.254.169.254" } },
    "S1",
  );
  await settle(socket, before);
  assert.equal(socket.sent.at(-1).method, "Target.closeTarget");
  guard.close();
});
