import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { assistantRoutes } from "../../server/http/routes/assistants.js";
import { assistantProblem } from "../../server/features/assistants/assistant-validation.js";
import { restartRequired } from "../../server/features/assistants/assistant-provider-synchronization.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

const affected = { agents: [{ id: "a", name: "Home" }], teamMembers: 1 };

async function serve(t, services) {
  const app = express();
  app.use(express.json());
  app.use(
    assistantRoutes({
      assistantFeature: { enabled: true },
      ...services,
      assistants: { maintenance: false, ...services.assistants },
    }),
  );
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message, key: error.key }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return (method, url, body) =>
    fetch(`${base}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
}
const expectRestart = async (response) => {
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    code: "ASSISTANT_RESTART_REQUIRED",
    error: serverMessages.assistants.webToolsRestartRequired,
    affected,
    messageKey: "assistants.webToolsRestartRequired",
  });
};

test("saving an agent passes the owner's restart confirmation and reports the need", async (t) => {
  const calls = [];
  const request = await serve(t, {
    assistants: {
      async update(id, patch, revision, options) {
        calls.push([id, patch, revision, options]);
        if (!options.confirmed)
          throw restartRequired("webToolsRestartRequired", affected);
        return { id, revision: revision + 1 };
      },
    },
  });
  const patch = { capabilities: { memory: false, reminders: false, browser: true } };
  await expectRestart(await request("PATCH", "/assistants/a", { revision: 3, ...patch }));
  const saved = await request("PATCH", "/assistants/a", {
    revision: 3,
    confirmRestart: true,
    ...patch,
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { id: "a", revision: 4 });
  // The confirmation is never part of the saved definition.
  assert.deepEqual(calls, [
    ["a", patch, 3, { confirmed: false, outcome: {} }],
    ["a", patch, 3, { confirmed: true, outcome: {} }],
  ]);
});

test("saving the search settings passes the confirmation and keeps busy reasons", async (t) => {
  const calls = [];
  let busy = false;
  const request = await serve(t, {
    assistantWebSearch: { get: () => ({ revision: 0, provider: "duckduckgo" }) },
    assistantWebTools: {
      async saveSearch(input, options) {
        calls.push([input, options]);
        if (busy) throw assistantProblem("active", 409);
        if (!options.confirmed)
          throw restartRequired("webToolsRestartRequired", affected);
        return { revision: 1, provider: input.provider };
      },
    },
  });
  const input = { revision: 0, provider: "brave", braveKey: "secret-fixture" };
  await expectRestart(await request("PUT", "/assistant-web-search", input));
  const saved = await request("PUT", "/assistant-web-search", {
    ...input,
    confirmRestart: true,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get("cache-control"), "no-store");
  assert.equal(JSON.stringify(await saved.json()).includes("secret-fixture"), false);
  busy = true;
  const refused = await request("PUT", "/assistant-web-search", {
    ...input,
    confirmRestart: true,
  });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).key, "active");
  assert.deepEqual(calls, [
    [input, { confirmed: false }],
    [input, { confirmed: true }],
    [input, { confirmed: true }],
  ]);
});

test("the runtime status reports whether a browser is available, without paths", async (t) => {
  const runtime = { status: () => ({ availability: "ready", sync: "current" }) };
  const get = async (detect) => {
    const request = await serve(t, {
      assistantRuntime: runtime,
      assistants: { store: { listAssistants: () => [] } },
      assistantWebTools: { detect },
    });
    const { browser } = await (await request("GET", "/assistant-runtime")).json();
    // Whether AgentPier can install its own browser here, and no Gateway to restart.
    const { installable, managed, restartNeeded, ...rest } = browser;
    assert.equal(typeof installable, "boolean");
    assert.equal(managed, false);
    assert.equal(restartNeeded, false);
    return { browser: rest };
  };
  const found = await get(() => ({
    available: true,
    name: "Chrome",
    executablePath: "/Applications/Secret/Chrome",
  }));
  const noApp = { available: false, reason: "noApp" };
  assert.deepEqual(found.browser, { available: true, name: "Chrome", visible: noApp });
  assert.deepEqual((await get(() => ({ available: false }))).browser, {
    available: false,
    visible: noApp,
  });
  assert.deepEqual(
    (
      await get(() => {
        throw new Error("boom");
      })
    ).browser,
    { available: false, visible: noApp },
  );
  // A visible window is reported with its reason, never with a path.
  const brave = await get(() => ({
    available: true,
    name: "Brave",
    executablePath: "/Applications/Secret/Brave",
    visible: { available: true },
  }));
  assert.deepEqual(brave.browser, {
    available: true,
    name: "Brave",
    visible: { available: true },
  });
  const headless = await get(() => ({
    available: true,
    name: "Brave",
    visible: { available: false, reason: "noDisplay" },
  }));
  assert.deepEqual(headless.browser.visible, { available: false, reason: "noDisplay" });
});

test("the agent browser routes report its state and reset its profile", async (t) => {
  const calls = [];
  const browsers = {
    status: (id) => (calls.push(["status", id]), { running: true, stored: true }),
    reset: async (id) => (calls.push(["reset", id]), { running: false, stored: false }),
  };
  const request = await serve(t, {
    assistantRuntime: { status: () => ({ availability: "ready", sync: "current" }) },
    assistants: { store: { listAssistants: () => [] }, browsers },
  });
  assert.deepEqual(await (await request("GET", "/assistants/a1/browser")).json(), {
    running: true,
    stored: true,
  });
  assert.deepEqual(
    await (await request("POST", "/assistants/a1/browser/reset", {})).json(),
    { running: false, stored: false },
  );
  assert.deepEqual(calls, [
    ["status", "a1"],
    ["reset", "a1"],
  ]);
});

test("the owner's restart now runs the pending restart and answers the runtime view", async (t) => {
  let pending = { since: 1, reasons: ["webSearch"], affected, waitingFor: [] };
  const calls = [];
  const request = await serve(t, {
    assistantRuntime: { status: () => ({ availability: "ready", sync: "ready" }) },
    assistants: {
      store: { listAssistants: () => [] },
      pendingRestart: {
        status: () => pending,
        restartNow: async () => {
          calls.push("now");
          pending = null;
          return { restarted: true };
        },
      },
    },
  });
  const response = await request("POST", "/assistant-runtime/pending-restart", {});
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["now"]);
  assert.equal((await response.json()).pendingRestart, null);
});
