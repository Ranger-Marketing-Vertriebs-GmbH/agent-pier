import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";
import { notFoundBody } from "../../server/http/responses.js";
import { ownerContentGuard } from "../../server/http/owner-content-guard.js";
import { ownerContentRoutes } from "../../server/http/owner-content-routes.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

// Anna's own agent with one of each content target: her chat, an upload, a turn, an
// approval and her Telegram channel. The owner has no opt-in.
async function annasTargets(f) {
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: user.id, level: "extended" }],
  });
  const request = as(f, cookie);
  const opened = await request(`/api/me/agents/${agent.id}/conversation`, {
    method: "POST",
  });
  const conversation = (await opened.json()).id;
  const uploaded = await fetch(
    `${f.url}/api/me/conversations/${conversation}/attachments?name=dot.png`,
    {
      method: "POST",
      headers: { cookie, origin: f.url, "content-type": "application/octet-stream" },
      body: png,
    },
  );
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const attachment = (await uploaded.json()).id;
  const assistants = f.application.assistants;
  const accepted = assistants.ledger.accept(conversation, {
    clientRequestId: "guard",
    text: "private",
    attachments: [],
  });
  const attempt = assistants.ledger.recordAttempt(accepted.id ?? accepted.request.id).id;
  const action = assistants.workflows.store.reserve({
    key: `approval-${conversation}`,
    assistantId: agent.id,
    conversationId: conversation,
    origin: { kind: "user", userId: user.id },
    payload: { action: "memory_write", projectId: "p", title: "Note", content: "x" },
    state: "awaiting_approval",
  }).id;
  f.application.assistantChannels.clientFactory = () => ({
    identity: async () => ({ id: 777, username: "anna_helper_bot" }),
  });
  const connected = await request(`/api/me/agents/${agent.id}/telegram`, {
    method: "PUT",
    body: { token: "123456:user-bot-secret-token", language: "en" },
  });
  assert.equal(connected.status, 200, await connected.clone().text());
  const channel = (await connected.json()).channel.id;
  return {
    conversation,
    attachment,
    attempt,
    action,
    channel,
    agent: agent.id,
    agentChats: agent.id,
  };
}

// Runs the guard on one request; returns the status it answered, or "next".
function guarded(services, method, path) {
  let outcome = "next";
  const res = {
    locals: {},
    status(code) {
      outcome = code;
      return this;
    },
    json(body) {
      assert.deepEqual(body, notFoundBody(), `${method} ${path}`);
    },
  };
  ownerContentGuard(services)(
    { principal: { role: "owner" }, method, baseUrl: "/api", path },
    res,
    () => {},
  );
  return outcome;
}

// Every registered owner content route on Anna's targets: `expect(method, kind)` is the
// status the guard must answer, or undefined where it may let the route run.
function everyRoute(f, targets, expect) {
  const outcomes = [];
  for (const [key, kind] of Object.entries(ownerContentRoutes)) {
    const [method, route] = key.split(" ");
    const path = (literal) => {
      let first = true;
      return route
        .replace(/^\/api/, "")
        .split("/")
        .map((part) => {
          if (!part.startsWith(":")) return literal(part);
          const value = first ? targets[kind] : "x";
          first = false;
          return encodeURIComponent(value);
        })
        .join("/");
    };
    const plain = path((part) => part);
    const wanted = expect(method, kind);
    // A trailing slash or other letter case reaches the same Express route.
    for (const variant of [
      plain,
      `${plain}/`,
      `${plain}//`,
      path((p) => p.toUpperCase()),
    ]) {
      const outcome = guarded(f.application, method, variant);
      outcomes.push(outcome);
      if (wanted !== undefined) assert.equal(outcome, wanted, `${key} → ${variant}`);
    }
  }
  return outcomes;
}

test("the guard refuses every owner content route on a user's private target", async (t) => {
  const { f } = await chatFixture(t);
  const targets = await annasTargets(f);
  everyRoute(f, targets, () => 404);
});

test("under her opt-in the guard still refuses every owner write on her targets", async (t) => {
  const { f } = await chatFixture(t);
  const targets = await annasTargets(f);
  const anna = f.application.assistants.store.getAssistant(targets.agent).userAccess
    .members[0].userId;
  const optIn = await f.request(`/api/users/${anna}/owner-may-read`, {
    method: "PUT",
    body: { enabled: true },
  });
  assert.equal(optIn.status, 200, await optIn.clone().text());
  // He reads from its since, but never writes, decides her turns or clears her files.
  const refused = (method, kind) =>
    !["GET", "HEAD"].includes(method) ||
    ["action", "attempt", "agentChats"].includes(kind)
      ? 404
      : undefined;
  const outcomes = everyRoute(f, targets, refused);
  // The opt-in is in force: some reads go through.
  assert.ok(outcomes.includes("next"));
});

test("a trailing slash does not open a user's chat to the owner", async (t) => {
  const { f } = await chatFixture(t);
  const { conversation, agent } = await annasTargets(f);
  for (const endpoint of [
    `/api/assistant-conversations/${conversation}/messages/`,
    `/api/Assistant-Conversations/${conversation}/Messages`,
    `/api/assistants/${agent}/reminders/`,
  ]) {
    const response = await f.request(endpoint);
    assert.equal(response.status, 404, endpoint);
    assert.deepEqual(await response.json(), notFoundBody(), endpoint);
  }
  const sent = await f.request(`/api/assistant-conversations/${conversation}/messages/`, {
    method: "POST",
    body: { clientRequestId: "owner", text: "hello from owner" },
  });
  assert.equal(sent.status, 404);
});

test("the owner cannot clear the attachments of a shared agent's user chats", async (t) => {
  const { f } = await chatFixture(t);
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "shared",
    members: [{ userId: user.id, level: "extended" }],
  });
  const request = as(f, cookie);
  const opened = await request(`/api/me/agents/${agent.id}/conversation`, {
    method: "POST",
  });
  const conversation = (await opened.json()).id;
  const uploaded = await fetch(
    `${f.url}/api/me/conversations/${conversation}/attachments?name=dot.png`,
    {
      method: "POST",
      headers: { cookie, origin: f.url, "content-type": "application/octet-stream" },
      body: png,
    },
  );
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const file = (await uploaded.json()).id;
  const cleared = await f.request(`/api/assistants/${agent.id}/attachments`, {
    method: "DELETE",
  });
  assert.equal(cleared.status, 404);
  assert.deepEqual(await cleared.json(), notFoundBody());
  const served = await request(`/api/me/attachments/${file}`);
  assert.equal(served.status, 200, "her upload is still there");
});
