import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
test("team routes preserve owner boundary, revisions and public redaction", async (t) => {
  const f = await applicationFixture(t, enabledAssistants),
    a = f.application.assistants,
    teams = a.teams.store;
  const parent = a.store.createAssistant({
    name: "Parent",
    model: { connectionId: "c", modelId: "m" },
  });
  const chat = a.store.saveConversation({
    assistantId: parent.id,
    runtimeSessionKey: "private-session",
  });
  const request = a.ledger.accept(chat.id, { clientRequestId: "request", text: "Hello" }),
    attempt = a.ledger.recordAttempt(request.id);
  teams.recordContext(request.id, {
    kind: "telegram",
    channelId: "secret-channel",
    chatId: "secret-chat",
    userId: "secret-user",
  });
  const proposal = teams.propose({
    operationId: "call",
    parentAttemptId: attempt.id,
    objective: "Review",
    members: [{ name: "Member", role: "Reviewer", assignment: "Review" }],
  });
  const listed = await f.request("/api/assistant-teams");
  assert.equal(listed.status, 200);
  const text = await listed.text();
  for (const secret of [
    "private-session",
    "secret-channel",
    "secret-chat",
    "secret-user",
    attempt.id,
  ])
    assert.ok(!text.includes(secret));
  assert.equal((await fetch(f.url + "/api/assistant-teams")).status, 401);
  assert.equal(
    (
      await fetch(f.url + "/api/assistant-teams", {
        headers: { authorization: "Bearer machine" },
      })
    ).status,
    403,
  );
  const endpoint = `/api/assistant-team-proposals/${proposal.id}/decision`;
  assert.equal(
    (
      await f.request(endpoint, {
        method: "POST",
        origin: "https://foreign.invalid",
        body: { revision: 1, decision: "approve" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(endpoint, {
        method: "POST",
        body: { revision: 1, decision: "approve", origin: { kind: "owner" } },
      })
    ).status,
    400,
  );
  const accepted = await f.request(endpoint, {
    method: "POST",
    body: { revision: 1, decision: "approve" },
  });
  assert.equal(accepted.status, 200);
  assert.equal(
    (
      await f.request(endpoint, {
        method: "POST",
        body: { revision: 1, decision: "approve" },
      })
    ).status,
    409,
  );
  const member = teams.members(proposal.id)[0];
  assert.equal(
    (
      await f.request(`/api/assistant-team-members/${member.id}/promote`, {
        method: "POST",
        body: { revision: member.revision },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request(`/api/assistants/${parent.id}/team-policy`, {
        method: "PUT",
        body: { revision: 1, autonomous: true, maxMembers: 4, runTimeoutMinutes: 10 },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request(`/api/assistants/${parent.id}/team-policy`, {
        method: "PUT",
        body: { revision: 1, autonomous: false },
      })
    ).status,
    409,
  );
});
