import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";
import { webToolsSignature } from "../../server/features/assistants/openclaw-config/web-tools.js";

// A running Gateway started with the agents as they are now: a browser is installed,
// so a change of who may use it changes the compiled web sections.
function runningGateway(f) {
  const assistants = f.application.assistants;
  const web = assistants.webTools;
  web.detect = () => ({ available: true, executablePath: "/fixture/browser" });
  const restarts = [];
  web.restart = async (operation) => {
    restarts.push(true);
    const result = await operation();
    started();
    return result;
  };
  const started = () => {
    const webTools = {
      search: web.webSearch.resolve(),
      browser: web.detect(),
      searchPlugins: {},
      documentExtract: false,
      images: web.images(),
      pdf: web.pdf(),
    };
    assistants.runtime.webTools = {
      searchPlugins: {},
      documentExtract: false,
      signature: webToolsSignature({
        profiles: assistants.store.listAssistants(),
        webTools,
      }),
    };
  };
  started();
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

test("releasing the browser restarts the Gateway once the owner confirms, and her switch never does", async (t) => {
  const { f } = await chatFixture(t);
  const { user, cookie } = await signedInUser(f, "Anna");
  const access = { mode: "own", members: [{ userId: user.id, level: "extended" }] };
  const agent = await userAgent(f, access, {
    capabilities: { memory: true, reminders: false },
  });
  const { restarts } = runningGateway(f);
  // Her own browser profile changes the Gateway's sections: only the owner restarts it.
  const released = { ...access, released: ["browser"] };
  const asked = await assign(f, agent, released);
  assert.equal(asked.status, 409, await asked.clone().text());
  const body = await asked.json();
  assert.equal(body.code, "ASSISTANT_RESTART_REQUIRED");
  assert.ok(Array.isArray(body.affected.agents));
  assert.deepEqual(
    f.application.assistants.store.getAssistant(agent.id).userAccess.released,
    [],
  );
  const confirmed = await assign(f, agent, released, { confirmRestart: true });
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
  assert.equal(restarts.length, 1);
  assert.deepEqual(
    f.application.assistants.store.getAssistant(agent.id).userAccess.released,
    ["browser"],
  );
  // Her switch applies live: the Gateway already compiled her browser profile.
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
  assert.equal(restarts.length, 1);
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
  // A Gateway started before the release, without her browser profile.
  const assistants = f.application.assistants;
  const access = assistants.store.getAssistant(agent.id).userAccess;
  assistants.store.changeUserAgent(agent.id, { userAccess: { ...access, released: [] } });
  runningGateway(f);
  assistants.store.changeUserAgent(agent.id, { userAccess: access });
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
  runningGateway(f);
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
