import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { assistantRoutes } from "../../server/http/routes/assistants.js";
import { shellService } from "../helpers/assistant-shell-service.js";
import { messageIdentity } from "../../server/lib/i18n/message-identity.js";
import {
  applicationFixture,
  enabledAssistants,
  fixtureFetch,
} from "../helpers/application.js";

// Agent skills over HTTP: a real AssistantService and AssistantConfig whose Gateway
// is a double that merges patches like OpenClaw and answers skills.status.
const none = { bins: [], anyBins: [], env: [], config: [], os: [] };
const skill = (name, extra = {}) => ({
  name,
  description: `${name} skill`,
  source: "openclaw-bundled",
  bundled: true,
  filePath: `/host/secret/skills/${name}/SKILL.md`,
  baseDir: `/host/secret/skills/${name}`,
  eligible: true,
  blockedByAgentFilter: true,
  requirements: { ...none, bins: ["gh"] },
  missing: { ...none, bins: ["gh"] },
  install: [{ id: "brew", kind: "brew", label: "Install gh (brew)", bins: ["gh"] }],
  ...extra,
});

async function serve(t, f) {
  f.routeAudit = [];
  const app = express();
  app.use(express.json());
  app.use(
    assistantRoutes({
      assistantFeature: { enabled: true },
      assistants: f.service,
      audit: { append: (entry) => f.routeAudit.push(entry) },
    }),
  );
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({
      error: error.message,
      key: error.key,
      ...messageIdentity(error.message),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, url, body) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body && JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
}

test("GET skills lists bundled skills without host paths; PATCH assigns them", async (t) => {
  const f = shellService(t, ["Home"]);
  const [home] = f.agents;
  f.client.answers["skills.status"] = () => ({
    workspaceDir: "/host/secret/workspace",
    skills: [
      skill("github"),
      skill("clawhub", { requirements: none, missing: none }),
      skill("mine", { source: "openclaw-workspace", bundled: false }),
    ],
  });
  const request = await serve(t, f);
  const listed = await request("GET", `/assistants/${home.id}/skills`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, {
    assigned: [],
    shell: "off",
    skills: [
      {
        name: "clawhub",
        description: "clawhub skill",
        state: "ready",
        missing: none,
        usesShell: false,
        assigned: false,
        active: false,
        risk: "installsCode",
      },
      {
        name: "github",
        description: "github skill",
        state: "missing",
        missing: { ...none, bins: ["gh"] },
        usesShell: true,
        assigned: false,
        active: false,
      },
    ],
  });
  assert.ok(!JSON.stringify(listed.body).includes("/host/secret"));

  const saved = await request("PATCH", `/assistants/${home.id}`, {
    revision: 1,
    skills: ["github"],
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.skills, ["github"]);
  assert.deepEqual(f.live(home).skills, ["github"]);
  assert.deepEqual(
    f.routeAudit.map((e) => [e.action, e.details]),
    [["assistant.updated", { fields: ["skills"], skills: ["github"] }]],
  );
});

test("unknown, workspace and malformed skills and foreign agents are refused", async (t) => {
  const f = shellService(t, ["Home"]);
  const [home] = f.agents;
  f.client.answers["skills.status"] = () => ({
    skills: [skill("github"), skill("mine", { source: "openclaw-workspace" })],
  });
  const request = await serve(t, f);
  for (const name of ["unknown", "mine"]) {
    const refused = await request("PATCH", `/assistants/${home.id}`, {
      revision: 1,
      skills: [name],
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.messageKey, "assistants.skillUnavailable");
  }
  for (const skills of ["github", [""], ["../etc"], [{}]])
    assert.equal(
      (await request("PATCH", `/assistants/${home.id}`, { revision: 1, skills })).status,
      400,
    );
  assert.equal(f.store.getAssistant(home.id).revision, 1, "nothing stored");
  assert.equal((await request("GET", "/assistants/missing/skills")).status, 404);
  const member = f.store.reserveMember({
    id: "member-1",
    parent: home.id,
    assignment: { name: "Helper" },
    snapshot: { model: home.model, instructions: "" },
    teamId: "team",
    lifetime: "temporary",
  });
  assert.equal((await request("GET", `/assistants/${member.id}/skills`)).status, 400);
  const memberPatch = await request("PATCH", `/assistants/${member.id}`, {
    revision: 1,
    skills: ["github"],
  });
  assert.equal(memberPatch.status, 400);
  assert.equal(f.routeAudit.length, 0);
});

test("the skill routes are owner-only behind the application's login", async (t) => {
  const { url } = await applicationFixture(t, enabledAssistants);
  const skills = `${url}/api/assistants/missing/skills`;
  assert.equal((await fetch(skills)).status, 401);
  const patch = {
    method: "PATCH",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ revision: 1, skills: ["github"] }),
  };
  assert.equal((await fetch(`${url}/api/assistants/missing`, patch)).status, 401);
  // Logged in, a foreign origin is still refused for a change.
  assert.equal(
    (
      await fixtureFetch(`${url}/api/assistants/missing`, {
        ...patch,
        headers: { ...patch.headers, origin: "https://foreign.invalid" },
      })
    ).status,
    403,
  );
  // The owner reaches the route.
  assert.notEqual((await fixtureFetch(skills)).status, 401);
});
