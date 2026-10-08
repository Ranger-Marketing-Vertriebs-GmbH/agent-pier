import test from "node:test";
import assert from "node:assert/strict";
import { SessionReload } from "../../server/features/sessions/session-reload.js";
import { reloadedProvider } from "../../server/features/sessions/provider-configuration.js";

function reloadWith(session, toolRoutes) {
  const services = {
    sessions: { get: async () => structuredClone(session), list: async () => [] },
    activity: { read: async () => ({ state: "idle" }) },
    bindings: { resolve: async () => ({ id: "native" }) },
    providerConnections: {
      get: (id) => {
        if (id !== "c1") throw Object.assign(new Error("gone"), { status: 404 });
        return { id, toolRoutes };
      },
    },
  };
  return new SessionReload({ services, pollMs: 0 });
}
const base = {
  id: "s1",
  tool: "claude",
  status: "running",
  access: { providerConnectionId: "c1" },
  provider: { route: { mode: "native", source: "messages" } },
};

test("an unchanged route reports no route change", async () => {
  const status = await reloadWith(base, {
    claude: { mode: "native", source: "messages" },
  }).status("s1");
  assert.equal(status.routeChange, null);
});

test("a changed route reports from and to", async () => {
  const to = { mode: "adapter", source: "chatCompletions" };
  const status = await reloadWith(base, { claude: to }).status("s1");
  assert.deepEqual(status.routeChange, { from: base.provider.route, to });
});

test("a route that is no longer offered reports to: null", async () => {
  const status = await reloadWith(base, { claude: null }).status("s1");
  assert.deepEqual(status.routeChange, { from: base.provider.route, to: null });
});

test("native accounts, missing connections and route-less sessions report nothing", async () => {
  for (const session of [
    { ...base, access: undefined },
    { ...base, access: { providerConnectionId: "gone" } },
    { ...base, provider: {} },
  ])
    assert.equal((await reloadWith(session, {}).status("s1")).routeChange, null);
});

test("a reload records the route it launched, so the warning does not outlive it", () => {
  const to = { mode: "adapter", source: "chatCompletions" };
  assert.deepEqual(reloadedProvider(base.provider, { route: to, cliModelId: "x" }), {
    route: to,
  });
  assert.deepEqual(
    reloadedProvider(
      { requestedModelId: "qwen3", route: base.provider.route },
      { route: { ...to, extra: "dropped" } },
    ),
    { requestedModelId: "qwen3", route: to },
  );
  // Catalog launches carry no route; invalid routes are ignored.
  assert.deepEqual(reloadedProvider(base.provider, {}), base.provider);
  assert.deepEqual(
    reloadedProvider(base.provider, { route: { mode: "x", source: "messages" } }),
    base.provider,
  );
  assert.equal(reloadedProvider(undefined, { route: to }), undefined);
});
