import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { assistantShellRoutes } from "../../server/http/routes/assistant-shell.js";
import { registerResponses } from "../../server/http/responses.js";
import { routeAccess } from "../../server/http/route-access.js";
import { assistantProblem } from "../../server/features/assistants/assistant-validation.js";
import {
  AGENT_DETAIL_TOPICS,
  agentDetailTopics,
  agentSshChanged,
} from "../../server/features/assistants/live-topics.js";
import { personal, setup, trusted } from "../helpers/agent-ssh-shell-fixture.js";
import { hostA, hostB } from "../helpers/ssh-session-agents-fixture.js";

// GET /api/assistants/:id/ssh-agent and its live topic `agent.ssh-agent:<id>` on the
// fixture's real registry and AgentShellSsh; the agent store is the fixture's.
function services(s) {
  return {
    assistants: {
      store: {
        getAssistant(id) {
          const agent = s.get(id);
          if (!agent) throw assistantProblem("notFound", 404);
          return agent;
        },
      },
    },
    assistantAgentSsh: s.shell,
  };
}

async function serve(t, given) {
  const app = express();
  app.use("/api", assistantShellRoutes(given));
  registerResponses(app);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => server.close());
  return (path) => fetch(`http://127.0.0.1:${server.address().port}/api${path}`);
}

const pathOrToken = /agent\.sock|ssh-agents|_agents|[0-9a-f]{32}|\//;

test("the owner reads an agent's plain ssh status without paths or tokens", async (t) => {
  const s = setup(t);
  const a = s.add(personal(), [trusted(hostA), { accessId: hostB.id, mode: "approval" }]);
  await s.shell.refresh();
  const get = await serve(t, services(s));
  const res = await get(`/assistants/${a.id}/ssh-agent`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.deepEqual(body, {
    state: "ready",
    aliases: { [hostA.id]: s.shell.aliases(a.id)[hostA.id] },
  });
  assert.match(body.aliases[hostA.id], /^[a-z0-9][a-z0-9-]*$/);
  assert.doesNotMatch(JSON.stringify(Object.values(body.aliases)), pathOrToken);
  assert.doesNotMatch(JSON.stringify(body).replaceAll(hostA.id, ""), /[0-9a-f]{32}/);
});

test("an agent without shell says why; an unknown agent is the route's 404", async (t) => {
  const s = setup(t);
  const off = s.add(personal({ shell: "off" }), [trusted(hostA)]);
  await s.shell.refresh();
  const get = await serve(t, services(s));
  assert.deepEqual(await (await get(`/assistants/${off.id}/ssh-agent`)).json(), {
    state: "unavailable",
    reason: "no-shell",
  });
  assert.equal((await get("/assistants/nope/ssh-agent")).status, 404);
});

test("without the agents' SSH adapter the status is failed, never an error", async (t) => {
  const s = setup(t);
  const a = s.add(personal(), [trusted(hostA)]);
  const get = await serve(t, { ...services(s), assistantAgentSsh: null });
  const res = await get(`/assistants/${a.id}/ssh-agent`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { state: "unavailable", reason: "failed" });
});

test("a restricted user never reaches the route", () => {
  let status = null;
  let passed = false;
  const res = { status: (code) => ((status = code), { json: () => {} }) };
  routeAccess()(
    {
      principal: { role: "user", userId: "u1" },
      method: "GET",
      baseUrl: "/api",
      path: "/assistants/a/ssh-agent",
    },
    res,
    () => (passed = true),
  );
  assert.equal(passed, false);
  assert.equal(status, 404);
});

test("agent.ssh-agent is an owner detail topic pushed by changes, never sampled", async (t) => {
  const s = setup(t);
  const a = s.add(personal(), [trusted(hostA)]);
  await s.shell.refresh();
  assert.ok(AGENT_DETAIL_TOPICS.includes("agent.ssh-agent"));
  const given = { ...services(s), assistantFeature: { enabled: true } };
  const topic = agentDetailTopics(given).find((d) => d.name === "agent.ssh-agent");
  assert.equal(topic.sampleMs, undefined);
  assert.equal(topic.mode, "state");
  assert.equal(topic.privacy, false);
  assert.equal(topic.authorize({ role: "owner" }, a.id), true);
  assert.equal(topic.authorize({ role: "user", userId: "u" }, a.id), false);
  // The topic's value is the route's answer.
  assert.deepEqual(await topic.read({ role: "owner" }, a.id), s.shell.status(a.id));
  await assert.rejects(topic.read({ role: "owner" }, "nope"), (error) => {
    assert.equal(error.status, 404);
    assert.equal(error.expected, true);
    return true;
  });
  // Without agent services it refuses like the routes.
  await assert.rejects(
    agentDetailTopics({ assistantFeature: { enabled: false } })
      .find((d) => d.name === "agent.ssh-agent")
      .read({ role: "owner" }, a.id),
    (error) => error.status === 404,
  );
  const hub = { invalidated: [], invalidate: (...args) => hub.invalidated.push(args) };
  agentSshChanged(hub, a.id);
  assert.deepEqual(hub.invalidated.at(-1), ["agent.ssh-agent", a.id]);
  // A failing hub is logged, never thrown.
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    agentSshChanged(
      {
        invalidate() {
          throw new Error("closed");
        },
      },
      a.id,
    );
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
});
