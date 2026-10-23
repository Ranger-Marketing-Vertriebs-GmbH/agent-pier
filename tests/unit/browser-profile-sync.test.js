import test from "node:test";
import assert from "node:assert/strict";
import { BrowserProfileSync } from "../../server/features/assistants/browser-profile-sync.js";
import { browserProfileMap } from "../../server/features/assistants/openclaw-config/browser-profiles.js";

const port = 40000;
const agent = (id, extra = {}) => ({
  id,
  runtimeAgentId: `ap-${id}`,
  capabilities: { browser: true },
  ...extra,
});

function fixture(agents, { browser = true } = {}) {
  const calls = [];
  let hash = 0;
  const runtime = {
    client: {
      ready: true,
      call: async (method, params) => {
        calls.push([method, params]);
        return method === "config.get" ? { config: {}, hash: `h${hash++}` } : {};
      },
    },
    webTools: {
      availability: { browser },
      visibleBrowser: true,
      port,
      browserProfiles: browser
        ? browserProfileMap({
            profiles: agents.list,
            browser: { visible: { available: true } },
            port,
          })
        : {},
    },
  };
  const stopped = [];
  const sync = new BrowserProfileSync({
    runtime,
    store: { listAssistants: () => agents.list },
    stop: async (name) => stopped.push(name),
  });
  const patches = () =>
    calls.filter(([m]) => m === "config.patch").map(([, p]) => JSON.parse(p.raw));
  return { sync, runtime, stopped, patches };
}

test("an agent switching the browser on gets its profile live, nobody else moves", async () => {
  const agents = { list: [agent("a")] };
  const f = fixture(agents);
  const before = f.runtime.webTools.browserProfiles["agent-a"];
  agents.list = [agent("a"), agent("b")];
  assert.deepEqual(await f.sync.sync(), ["agent-b"]);
  assert.deepEqual(f.patches(), [
    {
      browser: {
        profiles: {
          "agent-b": { driver: "openclaw", cdpPort: port + 21, headless: true },
        },
      },
    },
  ]);
  assert.deepEqual(f.runtime.webTools.browserProfiles["agent-a"], before);
  assert.equal(f.runtime.webTools.browserProfiles["agent-b"].agentId, "b");
  assert.deepEqual(f.stopped, []);
  // Nothing changed: no write at all.
  assert.deepEqual(await f.sync.sync(), []);
  assert.equal(f.patches().length, 1);
});

test("a window switched on, or the browser off, stops the running browser first", async () => {
  const agents = { list: [agent("a"), agent("b")] };
  const f = fixture(agents);
  agents.list = [agent("a", { browserVisible: true })];
  assert.deepEqual((await f.sync.sync()).sort(), ["agent-a", "agent-b"]);
  assert.deepEqual(f.stopped.sort(), ["agent-a", "agent-b"]);
  assert.deepEqual(f.patches()[0].browser.profiles, {
    "agent-a": { driver: "openclaw", cdpPort: port + 20, headless: false },
    "agent-b": null,
  });
});

test("without a compiled browser or a ready Gateway nothing is written", async () => {
  const agents = { list: [agent("a")] };
  const none = fixture(agents, { browser: false });
  assert.deepEqual(await none.sync.sync(), []);
  const stopped = fixture(agents);
  stopped.runtime.client.ready = false;
  agents.list = [agent("a"), agent("b")];
  assert.deepEqual(await stopped.sync.sync(), []);
  assert.deepEqual(stopped.patches(), []);
});

test("concurrent applies run one at a time and never share a CDP port", async () => {
  const agents = { list: [agent("a")] };
  const f = fixture(agents);
  // Each config write takes a moment, as over the Gateway connection.
  const call = f.runtime.client.call;
  f.runtime.client.call = async (method, params) => {
    await new Promise((r) => setTimeout(r, 5));
    return call(method, params);
  };
  agents.list = [agent("a"), agent("b")];
  const first = f.sync.sync();
  agents.list = [agent("a"), agent("b"), agent("c")];
  const second = f.sync.sync();
  assert.ok((await first).includes("agent-b"));
  await second;
  assert.deepEqual(Object.keys(f.runtime.webTools.browserProfiles).slice(-3), [
    "agent-a",
    "agent-b",
    "agent-c",
  ]);
  const ports = Object.values(f.runtime.webTools.browserProfiles).map((p) => p.cdpPort);
  assert.equal(new Set(ports).size, ports.length);
  const patched = f.patches().flatMap((patch) => Object.values(patch.browser.profiles));
  const patchedPorts = patched.map((profile) => profile.cdpPort);
  assert.equal(new Set(patchedPorts).size, patchedPorts.length);
});
