import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { memberGrantFixture } from "../helpers/member-grant-fixture.js";
import {
  personalCapabilities,
  personalShell,
  profileTools,
} from "../../server/features/assistants/native-capabilities.js";

const owner = { kind: "owner", channel: "ui" };
// The member's team task is over; the lead can still ask it questions or give it
// tasks (lead-requests.js), which run in its own chat.
const finish = (f) => f.teams.write(f.teams.member(f.member.id), { phase: "completed" });

test("a lead grants a finished member it re-engages, and its next turn has the tools", async (t) => {
  const f = await memberGrantFixture(t);
  finish(f);
  const result = await f.call({ grants: { browser: true } });
  assert.equal(result.status, "granted");
  // A lead-request turn applies the member's profile first; it compiles the grant.
  const tools = profileTools(f.agent(), true, true, true);
  assert.ok(tools.includes("browser") && tools.includes("web_search"));
  assert.equal(f.teams.member(f.member.id).grantLog.at(-1).by, "lead");
  assert.equal(f.audits.at(-1).details.kind, "member-grant");
});

test("a member reserved before grants gets the default and what the lead adds", async (t) => {
  const f = await memberGrantFixture(t);
  finish(f);
  f.teams.write(f.teams.member(f.member.id), { grants: undefined });
  const defaults = personalCapabilities(f.agent());
  assert.deepEqual(
    Object.keys(defaults).filter((key) => defaults[key]),
    ["memory", "webSearch", "webFetch"],
  );
  await f.call({ grants: { browser: true } });
  const caps = personalCapabilities(f.agent());
  assert.equal(caps.browser, true);
  assert.equal(caps.memory && caps.webSearch && caps.webFetch, true);
  assert.equal(caps.reminders, false);
  assert.deepEqual(f.teams.member(f.member.id).grants, {
    memory: true,
    webSearch: true,
    webFetch: true,
    browser: true,
  });
  assert.equal(f.audits.at(-1).details.kind, "member-grant");
});

test("an archived, promoted or never started member is still refused", async (t) => {
  for (const patch of [
    { phase: "completed", archivedAt: "2026-10-17" },
    { phase: "completed", lifetime: "permanent" },
    { phase: "cancelled", conversationId: null },
  ]) {
    const f = await memberGrantFixture(t);
    f.teams.write(f.teams.member(f.member.id), patch);
    await assert.rejects(f.call({ grants: { browser: true } }), {
      key: "teamGrantMemberEnded",
    });
  }
});

test("shell for a finished member still needs the setting and the owner's card", async (t) => {
  const f = await memberGrantFixture(t, { memberShellSsh: true });
  finish(f);
  const result = await f.call({ grants: { shell: "approval" } });
  assert.equal(result.status, "approval_requested");
  assert.equal(personalShell(f.agent()), "off");
  const [card] = f.workflows.store
    .list(f.channel.assistantId)
    .filter((a) => a.payload.action === "member_grant" && a.payload.approval);
  // The tick keeps the card for an addressable finished member.
  await f.workflows.tick();
  const waiting = f.workflows.store.get(card.id);
  assert.equal(waiting.state, "awaiting_approval");
  const decided = await f.workflows.decide(
    card.id,
    { revision: waiting.revision, decision: "approve" },
    owner,
  );
  assert.equal(decided.state, "completed");
  assert.equal(personalShell(f.agent()), "approval");
  // Archived before the owner decides, a second card fails closed.
  await f.grants.grant(await f.invocation(randomUUID()), {
    memberId: f.member.id,
    grants: { ssh: true },
  });
  const second = f.workflows.store
    .list(f.channel.assistantId)
    .find((a) => a.payload.approval && a.state === "awaiting_approval");
  f.teams.write(f.teams.member(f.member.id), { archivedAt: "2026-10-17" });
  const late = await f.workflows.decide(
    second.id,
    { revision: second.revision, decision: "approve" },
    owner,
  );
  assert.equal(late.state, "failed");
  assert.equal(late.diagnostic, "GRANT_REVOKED");
});
