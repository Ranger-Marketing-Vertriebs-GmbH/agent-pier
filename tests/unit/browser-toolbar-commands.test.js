import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BrowserLiveView } from "../../server/features/assistants/browser-live-view.js";

// The takeover's browser toolbar (browser-takeover.js, browser-navigation.js): only the
// holder navigates, goes back and forward, reloads, stops and switches or closes tabs.
// An address goes to OpenClaw's own POST /navigate (its navigation policy applies),
// tab commands to its tab routes, history commands as CDP calls to the shown tab.

const settle = async () => {
  for (let n = 0; n < 5; n++) await new Promise((r) => setTimeout(r, 2));
};

function fixture({ allowPrivateNetwork = false } = {}) {
  const gateway = {
    tabs: [
      { targetId: "CDP-1", url: "https://a.example/" },
      { targetId: "CDP-2", url: "https://login.example/" },
    ],
    requests: [],
    tickets: [],
    sockets: [],
    refuseNavigation: null,
  };
  const client = {
    ready: true,
    request: async (_m, { method, path, query, body }) => {
      if (path === "/") return { running: true };
      if (path === "/tabs") return { tabs: gateway.tabs };
      if (path === "/screencast") {
        gateway.tickets.push(body);
        return { wsPath: "/w", targetId: body.targetId || "CDP-1" };
      }
      gateway.requests.push({ method, path, query, body });
      if (path === "/navigate" && gateway.refuseNavigation)
        throw Error(gateway.refuseNavigation);
      return { ok: true };
    },
    openStream: () => {
      const ws = new EventEmitter();
      ws.close = () => ws.emit("close", 1000);
      gateway.sockets.push(ws);
      return ws;
    },
  };
  const cdp = {
    calls: [],
    history: {
      currentIndex: 1,
      entries: [
        { id: 1, url: "https://a.example/" },
        { id: 2, url: "https://b.example/" },
        { id: 3, url: "http://192.168.1.1/" },
      ],
    },
  };
  const live = new BrowserLiveView({
    browsers: {
      viewProfile: () => ({ name: "agent-a", entry: { cdpPort: 4321, headless: false } }),
      viewReason: () => "noProfile",
      watched() {},
    },
    runtime: { client },
    pollMs: 60_000,
    cdpInput: (port) => ({
      cdpPort: port,
      dispatch: async (targetId, calls) => {
        cdp.calls.push({ port, targetId, calls });
        return calls.map(([method]) =>
          method === "Page.getNavigationHistory" ? cdp.history : {},
        );
      },
      close() {},
    }),
    navigationPolicy: () => ({ allowPrivateNetwork }),
    lookup: async (host) =>
      host.endsWith(".example")
        ? [{ address: "93.184.216.34", family: 4 }]
        : Promise.reject(Error("ENOTFOUND")),
  });
  const states = [];
  const viewer = { state: (s) => states.push(s), frame() {}, end() {} };
  return { live, gateway, cdp, viewer, states };
}

test("only the holder navigates; an address goes through OpenClaw's navigation", async () => {
  const f = fixture();
  const view = f.live.subscribe("a", f.viewer, { holder: "laptop" });
  await settle();
  await assert.rejects(
    view.navigate({ type: "navigate", action: "go", url: "b.example" }),
    {
      code: "NOT_HOLDER",
    },
  );
  const preview = f.live.subscribe("a", f.viewer, { preview: true, holder: "laptop" });
  await assert.rejects(preview.navigate({ type: "navigate", action: "reload" }), {
    code: "VIEW_ONLY",
  });
  await assert.rejects(preview.tab({ type: "tab", action: "close", targetId: "CDP-2" }), {
    code: "VIEW_ONLY",
  });
  view.take();
  await view.navigate({ type: "navigate", action: "go", url: "b.example/path" });
  assert.deepEqual(f.gateway.requests, [
    {
      method: "POST",
      path: "/navigate",
      query: { profile: "agent-a" },
      body: { url: "https://b.example/path", targetId: "CDP-1" },
    },
  ]);
  await assert.rejects(
    view.navigate({ type: "navigate", action: "go", url: "javascript:x" }),
    {
      code: "INVALID_NAVIGATION",
    },
  );
  // The private-network rule of the agent browser applies before anything is sent.
  await assert.rejects(
    view.navigate({ type: "navigate", action: "go", url: "http://127.0.0.1:4380/" }),
    { code: "NAVIGATION_BLOCKED" },
  );
  assert.equal(f.gateway.requests.length, 1);
  // OpenClaw's own policy refusal is reported as blocked as well.
  f.gateway.refuseNavigation = "Navigation blocked: strict browser SSRF policy";
  await assert.rejects(
    view.navigate({ type: "navigate", action: "go", url: "c.example" }),
    {
      code: "NAVIGATION_BLOCKED",
    },
  );
  f.gateway.refuseNavigation = "timeout";
  await assert.rejects(
    view.navigate({ type: "navigate", action: "go", url: "c.example" }),
    {
      code: "NAVIGATION_FAILED",
    },
  );
  view.close();
  preview.close();
});

test("the owner's opt-in to private networks lets the owner open them too", async () => {
  const f = fixture({ allowPrivateNetwork: true });
  const view = f.live.subscribe("a", f.viewer, { holder: "laptop" });
  await settle();
  view.take();
  await view.navigate({ type: "navigate", action: "go", url: "http://127.0.0.1:8080/" });
  assert.equal(f.gateway.requests[0].body.url, "http://127.0.0.1:8080/");
  view.close();
});

test("back, forward, reload and stop reach the shown tab as CDP calls", async () => {
  const f = fixture();
  const view = f.live.subscribe("a", f.viewer, { holder: "laptop" });
  await settle();
  view.take();
  await view.navigate({ type: "navigate", action: "reload" });
  await view.navigate({ type: "navigate", action: "stop" });
  await view.navigate({ type: "navigate", action: "back" });
  assert.deepEqual(
    f.cdp.calls.map(({ port, targetId, calls }) => [port, targetId, calls]),
    [
      [4321, "CDP-1", [["Page.reload", {}]]],
      [4321, "CDP-1", [["Page.stopLoading", {}]]],
      [4321, "CDP-1", [["Page.getNavigationHistory", {}]]],
      [4321, "CDP-1", [["Page.navigateToHistoryEntry", { entryId: 1 }]]],
    ],
  );
  // Forward would open a private address the agent's browser may not open.
  f.cdp.calls.length = 0;
  await assert.rejects(view.navigate({ type: "navigate", action: "forward" }), {
    code: "NAVIGATION_BLOCKED",
  });
  assert.deepEqual(
    f.cdp.calls.map(({ calls }) => calls[0][0]),
    ["Page.getNavigationHistory"],
  );
  // At the start of the history back does nothing.
  f.cdp.calls.length = 0;
  f.cdp.history.currentIndex = 0;
  await view.navigate({ type: "navigate", action: "back" });
  assert.equal(f.cdp.calls.length, 1);
  view.close();
});

test("the holder switches to another tab and closes one", async () => {
  const f = fixture();
  const view = f.live.subscribe("a", f.viewer, { holder: "laptop" });
  await settle();
  await assert.rejects(view.tab({ type: "tab", action: "switch", targetId: "CDP-2" }), {
    code: "NOT_HOLDER",
  });
  view.take();
  await view.tab({ type: "tab", action: "switch", targetId: "CDP-2" });
  await settle();
  assert.deepEqual(f.gateway.requests.at(-1), {
    method: "POST",
    path: "/tabs/focus",
    query: { profile: "agent-a" },
    body: { targetId: "CDP-2" },
  });
  // The view shows the chosen tab at once.
  assert.equal(f.gateway.tickets.at(-1).targetId, "CDP-2");
  assert.equal(f.states.at(-1).pinned, true);
  await view.tab({ type: "tab", action: "close", targetId: "CDP-2" });
  assert.deepEqual(f.gateway.requests.at(-1), {
    method: "DELETE",
    path: "/tabs/CDP-2",
    query: { profile: "agent-a", targetIdMode: "raw" },
    body: undefined,
  });
  // Only a tab of this browser is named.
  await assert.rejects(view.tab({ type: "tab", action: "close", targetId: "CDP-9" }), {
    code: "NO_TARGET",
  });
  await assert.rejects(view.tab({ type: "tab", action: "open", targetId: "CDP-1" }), {
    code: "INVALID_NAVIGATION",
  });
  view.close();
});

test("toolbar commands run in order and none runs after the hand-back", async () => {
  const f = fixture();
  const view = f.live.subscribe("a", f.viewer, { holder: "laptop" });
  await settle();
  view.take();
  const going = view.navigate({ type: "navigate", action: "go", url: "b.example" });
  const reloading = view.navigate({ type: "navigate", action: "reload" });
  view.handBack();
  await assert.rejects(going, { code: "NOT_HOLDER" });
  await assert.rejects(reloading, { code: "NOT_HOLDER" });
  assert.equal(f.gateway.requests.length, 0);
  assert.equal(f.cdp.calls.length, 0);
  view.close();
});
