import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { assistantRoutes } from "../../server/http/routes/assistants.js";
import { ownerPath, shellService } from "../helpers/assistant-shell-service.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { messageIdentity } from "../../server/lib/i18n/message-identity.js";

// The shell level "Automatic review" over HTTP (assistant-shell-routes.test.js covers
// the other levels): a real AssistantService and AssistantConfig whose Gateway is a
// fake that merges configuration patches like OpenClaw.
async function serve(t, f) {
  const app = express();
  app.use(express.json());
  app.use(
    assistantRoutes({
      assistantFeature: { enabled: true },
      assistants: f.service,
      audit: { append: () => {} },
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
const patch = (request, agent, body) => request("PATCH", `/assistants/${agent.id}`, body);

test("PATCH review: its own confirmation, compiled as auto, ordered below full", async (t) => {
  const f = shellService(t, ["Home"]);
  const [home] = f.agents;
  const request = await serve(t, f);
  const refused = await patch(request, home, { revision: 1, shell: "review" });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, {
    code: "ASSISTANT_SHELL_CONFIRMATION_REQUIRED",
    error: serverMessages.assistants.shellConfirmationRequired,
    required: ["confirmShell", "confirmReview"],
    messageKey: "assistants.shellConfirmationRequired",
  });
  // Neither the shell warning alone nor full access's confirmation is enough.
  for (const extra of [
    { confirmShell: true },
    { confirmShell: true, confirmFull: true },
  ]) {
    const halfway = await patch(request, home, {
      revision: 1,
      shell: "review",
      ...extra,
    });
    assert.equal(halfway.status, 409);
    assert.equal(halfway.body.messageKey, "assistants.shellReviewConfirmationRequired");
    assert.equal(
      halfway.body.error,
      serverMessages.assistants.shellReviewConfirmationRequired,
    );
    assert.deepEqual(halfway.body.required, ["confirmReview"]);
  }
  assert.equal(f.store.getAssistant(home.id).shell, undefined, "nothing saved");
  assert.equal(f.live(home).tools?.exec, undefined);

  const saved = await patch(request, home, {
    revision: 1,
    shell: "review",
    confirmShell: true,
    confirmReview: true,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.shell, "review");
  assert.deepEqual(f.live(home).tools.exec, {
    mode: "auto",
    strictInlineEval: true,
    pathPrepend: ownerPath,
  });
  assert.ok(f.client.effective().tools.allow.includes("exec"));

  // Full access is a raise from it and keeps its own confirmation.
  const higher = await patch(request, home, {
    revision: 2,
    shell: "full",
    confirmShell: true,
    confirmReview: true,
  });
  assert.equal(higher.status, 409);
  assert.deepEqual(higher.body.required, ["confirmFull"]);
  const full = await patch(request, home, {
    revision: 2,
    shell: "full",
    confirmShell: true,
    confirmFull: true,
  });
  assert.equal(full.status, 200);
  assert.equal(f.live(home).tools.exec.mode, "full");
  // Back down to the review, and on to With approval: lowering never asks.
  const lowered = await patch(request, home, { revision: 3, shell: "review" });
  assert.equal(lowered.status, 200);
  assert.equal(f.live(home).tools.exec.mode, "auto");
  const manual = await patch(request, home, { revision: 4, shell: "approval" });
  assert.equal(manual.status, 200);
  assert.deepEqual(f.live(home).tools.exec, {
    mode: "ask",
    strictInlineEval: true,
    pathPrepend: ownerPath,
  });
  assert.deepEqual(
    f.audit.map((e) => [e.details.shellFrom, e.details.shellTo]),
    [
      ["off", "review"],
      ["review", "full"],
      ["full", "review"],
      ["review", "approval"],
    ],
  );
});

test("creating an agent at review needs both confirmations", async (t) => {
  const f = shellService(t, ["Home"]);
  const request = await serve(t, f);
  const definition = {
    name: "Reviewed",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
    shell: "review",
  };
  for (const [extra, required] of [
    [{}, ["confirmShell", "confirmReview"]],
    [{ confirmShell: true }, ["confirmReview"]],
    [{ confirmReview: true }, ["confirmShell"]],
  ]) {
    const refused = await request("POST", "/assistants", { ...definition, ...extra });
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body.required, required);
  }
  assert.equal(f.store.listAssistants().length, 1, "nothing created");
  const created = await request("POST", "/assistants", {
    ...definition,
    confirmShell: true,
    confirmReview: true,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.shell, "review");
  assert.deepEqual(
    f.audit.map((e) => [e.resourceId, e.details]),
    [[created.body.id, { kind: "shell", shellFrom: "off", shellTo: "review" }]],
  );
});

test("a runtime without the review refuses the level, whatever is confirmed", async (t) => {
  const f = shellService(t, ["Home"]);
  const heron = f.store.createAssistant({
    name: "Heron",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
    runtime: "hermes",
  });
  const request = await serve(t, f);
  const refused = await patch(request, heron, {
    revision: 1,
    shell: "review",
    confirmShell: true,
    confirmReview: true,
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.messageKey, "assistants.shellLevelUnsupported");
  assert.equal(f.store.getAssistant(heron.id).shell, undefined);
  // Its own runtime's agents list the level in their runtime view; Hermes's do not.
  const { assistants } = (await request("GET", "/assistants")).body;
  const levels = (id) =>
    assistants.find((a) => a.id === id).runtimeInfo.capabilities.approvals.shellLevels;
  assert.deepEqual(levels(f.agents[0].id), ["off", "approval", "review", "full"]);
  assert.deepEqual(levels(heron.id), ["off", "approval", "every", "full"]);
});

test("a temporary member is refused the level like any other", async (t) => {
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
  const refused = await patch(request, member, {
    revision: 1,
    shell: "review",
    confirmShell: true,
    confirmReview: true,
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.key, "invalid");
});
