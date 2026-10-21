import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { as, chatFixture, sharedAgentOfTwo, userAgent } from "../helpers/user-chats.js";
import { signedInUser, upgradeStatus } from "../helpers/users.js";
import { notFoundBody } from "../../server/http/responses.js";
import {
  NOTE_HEADER,
  USER_NOTE_HEADER,
} from "../../server/features/assistants/agent-attachment-types.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

async function open(request, agentId) {
  const response = await request(`/api/me/agents/${agentId}/conversation`, {
    method: "POST",
  });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).id;
}

// Stages a picture in a chat: the user's route, or the owner's with `owner`.
async function upload(f, cookie, conversationId, owner = false) {
  const route = owner ? "assistant-conversations" : "me/conversations";
  const response = await fetch(
    `${f.url}/api/${route}/${conversationId}/attachments?name=dot.png`,
    {
      method: "POST",
      headers: { cookie, origin: f.url, "content-type": "application/octet-stream" },
      body: png,
    },
  );
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}

// Every conversation route of a user, for one conversation and attachment.
const conversationRoutes = (id, file) => [
  ["GET", `/api/me/conversations/${id}/messages`],
  ["POST", `/api/me/conversations/${id}/messages`, { clientRequestId: "x", text: "hi" }],
  ["POST", `/api/me/conversations/${id}/queued`, { text: "later" }],
  ["DELETE", `/api/me/conversations/${id}/queued`],
  ["GET", `/api/me/conversations/${id}/attachment-policy`],
  ["DELETE", `/api/me/conversations/${id}/attachments/${file}`],
  ["GET", `/api/me/conversations/${id}/shared-files/${file}`],
  ["GET", `/api/me/attachments/${file}`],
];

async function refusedEverywhere(f, request, cookie, id, file) {
  for (const [method, endpoint, body] of conversationRoutes(id, file)) {
    const response = await request(endpoint, { method, ...(body ? { body } : {}) });
    assert.equal(response.status, 404, `${method} ${endpoint}`);
    assert.deepEqual(await response.json(), notFoundBody(), `${method} ${endpoint}`);
  }
  // Staging a file into someone else's chat is refused before the body is read.
  const staged = await fetch(
    `${f.url}/api/me/conversations/${id}/attachments?name=dot.png`,
    {
      method: "POST",
      headers: { cookie, origin: f.url, "content-type": "application/octet-stream" },
      body: png,
    },
  );
  assert.equal(staged.status, 404, "POST attachments");
  assert.deepEqual(await staged.json(), notFoundBody(), "POST attachments");
  assert.equal(
    await upgradeStatus(f, `/api/assistant-conversations/${id}/stream`, cookie),
    404,
  );
}

const streamOpens = (f, id, cookie) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `${f.url.replace("http", "ws")}/api/assistant-conversations/${id}/stream`,
      { headers: { cookie, origin: f.url } },
    );
    socket.on("open", () => resolve(socket));
    socket.on("unexpected-response", (_req, res) =>
      reject(new Error(`refused ${res.statusCode}`)),
    );
    socket.on("error", () => {});
  });

test("a user chats with her agent", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: user.id, level: "personalize" }],
  });
  const request = as(f, cookie);
  const listed = await (await request("/api/me/agents")).json();
  assert.deepEqual(listed, [
    {
      id: agent.id,
      name: agent.name,
      avatar: null,
      shared: false,
      level: "personalize",
      conversationId: null,
      activity: { state: "idle", reason: null, label: null },
    },
  ]);
  const id = await open(request, agent.id);
  assert.equal(await open(request, agent.id), id);
  assert.equal((await (await request("/api/me/agents")).json())[0].conversationId, id);
  const file = await upload(f, cookie, id);
  const sent = await request(`/api/me/conversations/${id}/messages`, {
    method: "POST",
    body: { clientRequestId: "first", text: "Hello", attachments: [file.id] },
  });
  assert.equal(sent.status, 202, await sent.clone().text());
  const { attempt } = await sent.json();
  assert.equal(gateway.sent.length, 1);
  // Her files are announced as hers, not as the owner's.
  assert.ok(gateway.sent[0].message.includes(USER_NOTE_HEADER));
  assert.ok(!gateway.sent[0].message.includes(NOTE_HEADER));
  // The turn runs as hers, never as the owner's.
  const assistants = f.application.assistants;
  const turn = assistants.teams.store.context(
    assistants.ledger.getAttempt(attempt.id).requestId,
  );
  assert.equal(turn.kind, "user");
  assert.equal(turn.userId, user.id);
  const history = await (await request(`/api/me/conversations/${id}/messages`)).json();
  assert.equal(history.requests[0].text, "Hello");
  const snapshot = await request(`/api/me/conversations/${id}/messages?cursor=`);
  assert.equal(snapshot.status, 200);
  const served = await request(`/api/me/attachments/${file.id}`);
  assert.equal(served.status, 200);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);
  const policy = await request(`/api/me/conversations/${id}/attachment-policy`);
  assert.equal(policy.status, 200);
  const queued = await request(`/api/me/conversations/${id}/queued`, {
    method: "POST",
    body: { text: "And then?" },
  });
  assert.equal(queued.status, 200, await queued.clone().text());
  const back = await request(`/api/me/conversations/${id}/queued`, { method: "DELETE" });
  assert.equal((await back.json()).text, "And then?");
  const cancelled = await request(`/api/me/attempts/${attempt.id}/cancel`, {
    method: "POST",
  });
  assert.equal(cancelled.status, 200, await cancelled.clone().text());
  const socket = await streamOpens(f, id, cookie);
  socket.terminate();
});

test("user A cannot read user B's chat on a shared agent", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben, agent } = await sharedAgentOfTwo(f);
  const bId = await open(as(f, ben.cookie), agent.id);
  const file = await upload(f, ben.cookie, bId);
  await refusedEverywhere(f, as(f, anna.cookie), anna.cookie, bId, file.id);
  // Her own conversation id with B's file is refused as well.
  const aId = await open(as(f, anna.cookie), agent.id);
  assert.notEqual(aId, bId);
  const crossed = await as(
    f,
    anna.cookie,
  )(`/api/me/conversations/${aId}/shared-files/${file.id}`);
  assert.equal(crossed.status, 404);
});

test("a user cannot read the owner's chat on a shared agent", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, agent } = await sharedAgentOfTwo(f);
  const opened = await f.request(`/api/assistants/${agent.id}/conversations`, {
    method: "POST",
  });
  const owner = await opened.json();
  const file = await upload(f, f.cookie, owner.id, true);
  await refusedEverywhere(f, as(f, anna.cookie), anna.cookie, owner.id, file.id);
});

test("a user cannot open an unassigned agent", async (t) => {
  const { f } = await chatFixture(t);
  const { anna } = await sharedAgentOfTwo(f);
  const other = await signedInUser(f, "Carla");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: other.user.id, level: "chat" }],
  });
  const owner = await f.request("/api/assistants", {
    method: "POST",
    body: { name: "Mine", instructions: "", model: agent.model },
  });
  for (const id of [agent.id, (await owner.json()).id, "unknown"]) {
    const response = await as(f, anna.cookie)(`/api/me/agents/${id}/conversation`, {
      method: "POST",
    });
    assert.equal(response.status, 404, id);
    assert.deepEqual(await response.json(), notFoundBody());
  }
});

test("unassigning closes access", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben, agent } = await sharedAgentOfTwo(f);
  const id = await open(as(f, anna.cookie), agent.id);
  const socket = await streamOpens(f, id, anna.cookie);
  const closed = new Promise((resolve) => socket.on("close", resolve));
  const current = f.application.assistants.store.getAssistant(agent.id);
  const moved = await f.request(`/api/user-agents/${agent.id}/access`, {
    method: "PUT",
    body: {
      userAccess: { mode: "shared", members: [{ userId: ben.user.id, level: "chat" }] },
      revision: current.revision,
    },
  });
  assert.equal(moved.status, 200);
  assert.equal(await closed, 1008);
  await refusedEverywhere(f, as(f, anna.cookie), anna.cookie, id, "none");
  assert.deepEqual(await (await as(f, anna.cookie)("/api/me/agents")).json(), []);
});

test("a user cannot cancel another user's attempt", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben, agent } = await sharedAgentOfTwo(f);
  const bId = await open(as(f, ben.cookie), agent.id);
  const sent = await as(f, ben.cookie)(`/api/me/conversations/${bId}/messages`, {
    method: "POST",
    body: { clientRequestId: "b", text: "Mine" },
  });
  const { attempt } = await sent.json();
  for (const id of [attempt.id, "unknown"]) {
    const response = await as(f, anna.cookie)(`/api/me/attempts/${id}/cancel`, {
      method: "POST",
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), notFoundBody());
  }
});

test("a user reviews her own uncertain turn, and only hers", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben, agent } = await sharedAgentOfTwo(f);
  const assistants = f.application.assistants;
  // She never restarts the Gateway every agent shares.
  let restarts = 0;
  assistants.runtime.stop = async () => restarts++;
  assistants.runtime.start = async () => restarts++;
  const request = as(f, anna.cookie);
  const id = await open(request, agent.id);
  const send = (clientRequestId) =>
    request(`/api/me/conversations/${id}/messages`, {
      method: "POST",
      body: { clientRequestId, text: "Hello" },
    });
  const { attempt } = await (await send("first")).json();
  // The Gateway restarted during the send: the outcome is unknown.
  assistants.ledger.transition(attempt.id, "uncertain");
  assert.equal((await send("second")).status, 409);
  const recover = (cookie, attemptId) =>
    as(f, cookie)(`/api/me/attempts/${attemptId}/recover`, {
      method: "POST",
      body: { acknowledgeUnknownOutcome: true },
    });
  for (const [cookie, attemptId] of [
    [ben.cookie, attempt.id],
    [anna.cookie, "unknown"],
  ]) {
    const refused = await recover(cookie, attemptId);
    assert.equal(refused.status, 404);
    assert.deepEqual(await refused.json(), notFoundBody());
  }
  // The owner never decides her turns.
  const owner = await f.request(`/api/assistant-attempts/${attempt.id}/recover`, {
    method: "POST",
    body: { acknowledgeUnknownOutcome: true },
  });
  assert.equal(owner.status, 404);
  const reviewed = await recover(anna.cookie, attempt.id);
  assert.equal(reviewed.status, 200, await reviewed.clone().text());
  assert.ok((await reviewed.json()).reviewedAt);
  // Asking again stays a review, never a restart.
  assert.equal((await recover(anna.cookie, attempt.id)).status, 200);
  assert.equal(restarts, 0);
  assert.equal((await send("third")).status, 202);
});

test("a user's review aborts her run that may still go on before another turn starts", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { anna, agent } = await sharedAgentOfTwo(f);
  const assistants = f.application.assistants;
  const request = as(f, anna.cookie);
  const id = await open(request, agent.id);
  const send = (clientRequestId) =>
    request(`/api/me/conversations/${id}/messages`, {
      method: "POST",
      body: { clientRequestId, text: "Hello" },
    });
  const { attempt } = await (await send("first")).json();
  // The send timed out: the Gateway may still run the turn.
  assistants.ledger.transition(attempt.id, "uncertain", { unconfirmed: "send" });
  const recover = () =>
    request(`/api/me/attempts/${attempt.id}/recover`, {
      method: "POST",
      body: { acknowledgeUnknownOutcome: true },
    });
  // A Gateway that does not take the abort leaves the turn running and unreviewed.
  const call = gateway.client.call;
  gateway.client.call = async (method, params) => {
    if (method === "sessions.abort") throw Object.assign(Error("busy"), { code: "X" });
    return call(method, params);
  };
  assert.equal((await recover()).status, 409);
  assert.equal(assistants.ledger.getAttempt(attempt.id).reviewedAt, null);
  assert.equal((await send("second")).status, 409);
  gateway.client.call = call;
  const reviewed = await recover();
  assert.equal(reviewed.status, 200, await reviewed.clone().text());
  const key = assistants.store.getConversation(id).runtimeSessionKey;
  assert.deepEqual(
    gateway.calls.filter((c) => c.method === "sessions.abort").map((c) => c.params),
    [{ key, runId: attempt.runtimeRunId || attempt.id }],
  );
  assert.equal((await send("third")).status, 202);
});
