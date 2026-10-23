import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";
import { webToolsSignatures } from "../../server/features/assistants/openclaw-config/web-tools.js";

const installed = { available: true, executablePath: "/fixture/browser" };
// A running Gateway started with `browser` (none: installed after the start); a
// browser is installed now.
function runningGateway(f, browser = installed) {
  const assistants = f.application.assistants;
  const web = assistants.webTools;
  web.detect = () => installed;
  const restarts = [];
  web.restart = async (operation) => {
    restarts.push(true);
    const result = await operation();
    started(installed);
    return result;
  };
  const started = (detected) => {
    const webTools = {
      search: web.webSearch.resolve(),
      browser: detected,
      searchPlugins: {},
      documentExtract: false,
      images: web.images(),
      pdf: web.pdf(),
    };
    assistants.runtime.webTools = {
      searchPlugins: {},
      documentExtract: false,
      signatures: webToolsSignatures({ webTools }),
    };
  };
  started(browser);
  return { restarts };
}
const assign = (f, agent, userAccess, extra = {}) =>
  f.request(`/api/user-agents/${agent.id}/access`, {
    method: "PUT",
    body: {
      userAccess,
      revision: f.application.assistants.store.getAssistant(agent.id).revision,
      ...extra,
    },
  });

test("releasing the browser and her switch apply live once the Gateway has a browser", async (t) => {
  const { f } = await chatFixture(t);
  const { user, cookie } = await signedInUser(f, "Anna");
  const access = { mode: "own", members: [{ userId: user.id, level: "extended" }] };
  const agent = await userAgent(f, access, {
    capabilities: { memory: true, reminders: false },
  });
  const { restarts } = runningGateway(f);
  // The start compiled the browser block: her profile is added live.
  const released = { ...access, released: ["browser"] };
  const saved = await assign(f, agent, released);
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.deepEqual(
    f.application.assistants.store.getAssistant(agent.id).userAccess.released,
    ["browser"],
  );
  const request = as(f, cookie);
  const view = await (await request(`/api/me/agents/${agent.id}/settings`)).json();
  const on = await request(`/api/me/agents/${agent.id}/settings`, {
    method: "PATCH",
    body: { values: { capabilities: { browser: true } }, revision: view.revision },
  });
  assert.equal(on.status, 200, await on.clone().text());
  assert.equal(
    f.application.assistants.store.getAssistant(agent.id).capabilities.browser,
    true,
  );
  assert.equal(restarts.length, 0);
});

test("releasing a browser the Gateway started without saves it and queues the restart", async (t) => {
  const { f } = await chatFixture(t);
  const { user } = await signedInUser(f, "Anna");
  const access = { mode: "own", members: [{ userId: user.id, level: "extended" }] };
  const agent = await userAgent(f, access, {
    capabilities: { memory: true, reminders: false },
  });
  const { restarts } = runningGateway(f, { available: false });
  const queued = [];
  f.application.assistants.pendingRestart.request = (reason, affected) =>
    queued.push({ reason, affected });
  const released = { ...access, released: ["browser"] };
  const saved = await assign(f, agent, released);
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.deepEqual(
    f.application.assistants.store.getAssistant(agent.id).userAccess.released,
    ["browser"],
  );
  // No question and no restart now: it waits until nothing is busy.
  assert.equal(restarts.length, 0);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].reason, "webTools");
  assert.ok(Array.isArray(queued[0].affected.agents));
});

test("a switch that would still restart the Gateway is a plain refusal she can read", async (t) => {
  const { f } = await chatFixture(t);
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(
    f,
    {
      mode: "own",
      members: [{ userId: user.id, level: "extended" }],
      released: ["browser"],
    },
    { capabilities: { memory: true, reminders: false } },
  );
  // A Gateway started before the browser was installed.
  const assistants = f.application.assistants;
  runningGateway(f, { available: false });
  const request = as(f, cookie);
  const view = await (await request(`/api/me/agents/${agent.id}/settings`)).json();
  const on = await request(`/api/me/agents/${agent.id}/settings`, {
    method: "PATCH",
    body: { values: { capabilities: { browser: true } }, revision: view.revision },
  });
  assert.equal(on.status, 409);
  const body = await on.json();
  assert.equal(body.code, "USER_AGENT_RESTART_NEEDED");
  assert.notEqual(assistants.store.getAssistant(agent.id).capabilities.browser, true);
});

test("a new user agent starts without releases the running Gateway lacks", async (t) => {
  const { f } = await chatFixture(t);
  const { user } = await signedInUser(f, "Anna");
  runningGateway(f, { available: false });
  const agent = await userAgent(
    f,
    {
      mode: "own",
      members: [{ userId: user.id, level: "extended" }],
      released: ["browser"],
    },
    { capabilities: { memory: true, reminders: false } },
  );
  assert.deepEqual(agent.userAccess.released, []);
});
