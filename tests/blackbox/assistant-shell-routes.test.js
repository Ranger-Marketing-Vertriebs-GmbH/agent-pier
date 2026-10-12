import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { assistantRoutes } from "../../server/http/routes/assistants.js";
import { shellService } from "../helpers/assistant-shell-service.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { messageIdentity } from "../../server/lib/i18n/message-identity.js";
import {
  applicationFixture,
  enabledAssistants,
  fixtureFetch,
} from "../helpers/application.js";

// The agent shell over HTTP: a real AssistantService and AssistantConfig whose
// Gateway is a fake that merges configuration patches like OpenClaw.
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
const shellOf = async (request, id) =>
  (await request("GET", "/assistants")).body.assistants.find((a) => a.id === id).shell;

test("PATCH shell: confirmations, 409 with stable keys, immediate lowering", async (t) => {
  const f = shellService(t, ["Home"]);
  const [home] = f.agents;
  const request = await serve(t, f);
  const refused = await request("PATCH", `/assistants/${home.id}`, {
    revision: 1,
    shell: "full",
  });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, {
    code: "ASSISTANT_SHELL_CONFIRMATION_REQUIRED",
    error: serverMessages.assistants.shellConfirmationRequired,
    required: ["confirmShell", "confirmFull"],
    messageKey: "assistants.shellConfirmationRequired",
  });
  const halfway = await request("PATCH", `/assistants/${home.id}`, {
    revision: 1,
    shell: "full",
    confirmShell: true,
  });
  assert.equal(halfway.status, 409);
  assert.equal(halfway.body.messageKey, "assistants.shellFullConfirmationRequired");
  assert.deepEqual(halfway.body.required, ["confirmFull"]);
  assert.equal(await shellOf(request, home.id), undefined, "nothing saved");

  const full = await request("PATCH", `/assistants/${home.id}`, {
    revision: 1,
    shell: "full",
    confirmShell: true,
    confirmFull: true,
  });
  assert.equal(full.status, 200);
  assert.equal(full.body.shell, "full");
  assert.equal(full.body.pending, undefined);
  assert.equal(f.live(home).tools.exec.mode, "full");

  // Lowering needs no confirmation and the Gateway loses exec at once.
  const off = await request("PATCH", `/assistants/${home.id}`, {
    revision: 2,
    shell: "off",
  });
  assert.equal(off.status, 200);
  assert.equal(off.body.shell, "off");
  assert.equal(f.live(home).tools.exec, undefined);
  assert.equal(f.client.effective().tools.allow.includes("exec"), false);
  assert.equal(f.client.effective().tools.allow.includes("process"), false);
  assert.deepEqual(
    f.audit.map((e) => [e.details.shellFrom, e.details.shellTo]),
    [
      ["off", "full"],
      ["full", "off"],
    ],
  );
});

test("shell allowlist routes list and delete entries; unknown is 404", async (t) => {
  const f = shellService(t, ["Home"]);
  const [home] = f.agents;
  let file = {
    version: 1,
    agents: {
      [home.runtimeAgentId]: {
        allowlist: [
          {
            id: "one",
            pattern: "/usr/bin/touch",
            source: "allow-always",
            argPattern: "sha256:x",
          },
          { id: "two", pattern: "/bin/ls" },
        ],
      },
    },
  };
  let hash = 1;
  f.client.answers["exec.approvals.get"] = () => ({ file, hash: String(hash) });
  f.client.answers["exec.approvals.set"] = (params) => {
    assert.equal(params.baseHash, String(hash));
    file = params.file;
    hash++;
    return { file, hash: String(hash) };
  };
  const request = await serve(t, f);
  const listed = await request("GET", `/assistants/${home.id}/shell-allowlist`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, {
    entries: [
      {
        id: "one",
        pattern: "/usr/bin/touch",
        argPattern: "sha256:x",
        source: "openclaw",
        kind: "program",
      },
      { id: "two", pattern: "/bin/ls", source: "other", kind: "program" },
    ],
  });
  const removed = await request("DELETE", `/assistants/${home.id}/shell-allowlist/one`);
  assert.equal(removed.status, 200);
  assert.deepEqual(
    removed.body.entries.map((e) => e.id),
    ["two"],
  );
  assert.deepEqual(
    (await request("GET", `/assistants/${home.id}/shell-allowlist`)).body.entries.map(
      (e) => e.id,
    ),
    ["two"],
  );
  const unknown = await request("DELETE", `/assistants/${home.id}/shell-allowlist/one`);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.messageKey, "assistants.allowlistEntryNotFound");
  assert.equal((await request("GET", "/assistants/missing/shell-allowlist")).status, 404);
  assert.deepEqual(
    f.audit.map((e) => [e.action, e.details]),
    [["assistant.revoked", { kind: "allowlist", entryId: "one" }]],
  );
});

test("temporary members get 400 from the shell routes", async (t) => {
  const f = shellService(t, ["Lead"]);
  const member = f.store.reserveMember({
    id: "member-1",
    parent: f.agents[0].id,
    assignment: { name: "Helper" },
    snapshot: { model: { connectionId: "c", modelId: "m" }, instructions: "" },
    teamId: "team",
    lifetime: "temporary",
  });
  const request = await serve(t, f);
  for (const [method, url, body] of [
    [
      "PATCH",
      `/assistants/${member.id}`,
      { revision: 1, shell: "approval", confirmShell: true },
    ],
    ["GET", `/assistants/${member.id}/shell-allowlist`],
    ["DELETE", `/assistants/${member.id}/shell-allowlist/one`],
  ]) {
    const response = await request(method, url, body);
    assert.equal(response.status, 400, `${method} ${url}`);
    assert.equal(response.body.key, "invalid");
  }
});

test("creating an agent with shell needs the same confirmations", async (t) => {
  const f = shellService(t, ["Home"]);
  const request = await serve(t, f);
  const definition = {
    name: "Shell",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
    shell: "full",
  };
  for (const [extra, required] of [
    [{}, ["confirmShell", "confirmFull"]],
    [{ confirmShell: true }, ["confirmFull"]],
    [{ confirmFull: true }, ["confirmShell"]],
  ]) {
    const refused = await request("POST", "/assistants", { ...definition, ...extra });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "ASSISTANT_SHELL_CONFIRMATION_REQUIRED");
    assert.deepEqual(refused.body.required, required);
  }
  assert.equal(f.store.listAssistants().length, 1, "nothing created");
  const created = await request("POST", "/assistants", {
    ...definition,
    confirmShell: true,
    confirmFull: true,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.shell, "full");
  assert.deepEqual(
    f.audit.map((e) => [e.resourceId, e.details]),
    [[created.body.id, { kind: "shell", shellFrom: "off", shellTo: "full" }]],
  );
  // Off, or no level at all, needs nothing.
  const plain = await request("POST", "/assistants", { ...definition, shell: "off" });
  assert.equal(plain.status, 201);
});

test("the shell routes are owner-only behind the application's login and origin checks", async (t) => {
  const { url } = await applicationFixture(t, enabledAssistants);
  const allowlist = `${url}/api/assistants/missing/shell-allowlist`;
  assert.equal((await fetch(allowlist)).status, 401);
  assert.equal(
    (await fetch(`${allowlist}/entry`, { method: "DELETE", headers: { origin: url } }))
      .status,
    401,
  );
  const patch = {
    method: "PATCH",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ revision: 1, shell: "full" }),
  };
  assert.equal((await fetch(`${url}/api/assistants/missing`, patch)).status, 401);
  // Logged in, a foreign or missing origin is still refused for a change.
  for (const headers of [{ origin: "https://foreign.invalid" }, {}])
    assert.equal(
      (await fixtureFetch(`${allowlist}/entry`, { method: "DELETE", headers })).status,
      403,
    );
  // The owner reaches the routes.
  assert.equal((await fixtureFetch(allowlist)).status, 404);
  assert.equal(
    (
      await fixtureFetch(`${allowlist}/entry`, {
        method: "DELETE",
        headers: { origin: url },
      })
    ).status,
    404,
  );
});
