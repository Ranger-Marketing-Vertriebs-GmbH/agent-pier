import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ask, writeGate } from "../helpers/lead-request-service-fixture.js";
import { execFixture } from "../helpers/assistant-exec-fixture.js";
import { memoryTarget } from "../../server/features/assistants/lead-request-writes.js";

// Every layer of the write gate on its own: each check below fails when its
// condition is removed from LeadRequests.mayWrite.
test("only the proven task's own running attempt writes", async (t) => {
  const f = await writeGate(t);
  const { requestId } = await f.delegate(f.turn());
  const r = f.service.requests.store.get(requestId);
  const may = (patch = {}, attemptId = r.attemptId) => {
    f.service.store.write(f.service.requests.store.get(r.id), patch);
    return f.service.requests.mayWrite(r.id, attemptId, f.member.id, "notes/plan.md");
  };
  assert.equal(may(), true, "positive control");
  assert.equal(may({}, "another-attempt"), false, "another attempt");
  assert.equal(may({ phase: "uncertain" }), false, "not running");
  assert.equal(may({ phase: "running" }), true);
  assert.equal(may({ ownerProof: null }), false, "no owner proof");
  assert.equal(may({ ownerProof: r.ownerProof, writeAllowed: false }), false, "no grant");
  assert.equal(may({ writeAllowed: true, type: "question" }), false, "a question");
  assert.equal(may({ type: "task" }), true);
  assert.equal(
    f.service.requests.mayWrite(r.id, r.attemptId, f.parent.id, "notes/plan.md"),
    false,
    "another agent",
  );
  // Through the bridge: a later member turn that claims the request is refused.
  assert.equal(f.write(), true);
  f.complete(r.attemptId);
  const forged = f.assistants.ledger.accept(f.memberChat.id, {
    clientRequestId: "forged",
    text: "Write anyway",
  });
  f.service.store.recordContext(forged.id, { kind: "lead-request", requestId: r.id });
  f.assistants.ledger.recordAttempt(forged.id);
  assert.equal(f.write(), false);
});

test("a question never writes, even with a stored grant", async (t) => {
  const f = await writeGate(t);
  f.service.requests.waitMs = 0;
  await ask(f, f.permanent, f.turn());
  const q = f.service.requests.store.list()[0];
  f.service.store.write(q, {
    writeAllowed: true,
    ownerProof: { quote: "x", sentence: 0 },
  });
  assert.equal(f.write(), false);
});

test("memory stays read-only in every spelling and through links", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lead-writes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const own = path.join(root, "member");
  fs.mkdirSync(path.join(own, "memory"), { recursive: true });
  fs.mkdirSync(path.join(own, "docs"));
  fs.symlinkSync(path.join(own, "memory"), path.join(own, "notes"));
  fs.symlinkSync(path.join(own, "MEMORY.md"), path.join(own, "brief.md"));
  const memory = (target) => memoryTarget(root, "ap-member", target);
  for (const target of [
    "memory/today.md",
    "MEMORY.md",
    "Memory/x.md",
    "./memory/x.md",
    "docs/../memory/x.md",
    " memory/x.md",
    "memory/x.md</arg_value>>",
    "@memory/x.md",
    "notes/x.md",
    "brief.md",
    "../other/x.md",
  ])
    assert.equal(memory(target), true, target);
  for (const target of ["docs/plan.md", "plan.md", "docs/new/deep.md", "memoryless.md"])
    assert.equal(memory(target), false, target);
  // Without a known workspace only the spelling decides.
  assert.equal(memoryTarget(undefined, "ap-member", "notes/x.md"), false);
  assert.equal(memoryTarget(undefined, "ap-member", "memory/x.md"), true);
});

test("the archive re-checks a request made after its first check", async (t) => {
  const f = await writeGate(t);
  const store = f.service.requests.store;
  const archivable = store.archivable.bind(store);
  // Between the first check and the archiving transaction a question arrives.
  store.archivable = (...args) => {
    const members = archivable(...args);
    f.service.requests.waitMs = 0;
    store.create({
      type: "question",
      attemptId: f.turn().attemptId,
      operationId: "late",
      input: { memberId: f.temporary.id, question: "Still there?" },
    });
    return members;
  };
  await assert.rejects(f.service.archive(f.turn(), { memberIds: [f.temporary.id] }), {
    status: 409,
  });
  assert.equal(f.service.store.member(f.temporary.id).archivedAt, null);
});

// R2: requests run without the owner, but a member whose shell asks for approval
// still asks the owner before every command of a lead's turn.
test("a member's shell approval still applies to a lead's request", async (t) => {
  const f = await execFixture(t);
  const action = await f.request(
    "lead-exec",
    {},
    { kind: "lead-request", requestId: "r", leadName: "Lead", display: "Run it" },
  );
  assert.equal(action.state, "awaiting_approval");
  assert.equal(action.payload.command, "git status");
  assert.deepEqual(f.resolves(), [], "nothing ran without the owner");
});

// AGENTPIER-68: the owner decided that an @mention alone is a request to that
// member, write rights for a delegated task included; a negated one is not.
test("a mention-only owner message lets the delegated task write", async (t) => {
  const f = await writeGate(t);
  const text = `@${f.member.name.toUpperCase()} trag den neuen NAS in die Doku ein`;
  const { requestId } = await f.delegate(f.turn(text), { ownerRequestQuote: text });
  const r = f.service.requests.store.get(requestId);
  assert.equal(r.writeAllowed, true);
  assert.equal(r.ownerProof.quote, text);
  assert.equal(f.write(), true);
});

test("the lead need not quote the owner's mention", async (t) => {
  const f = await writeGate(t);
  const text = `@${f.member.name} trag den neuen NAS in die Doku ein`;
  const { requestId } = await f.delegate(f.turn(text), {
    ownerRequestQuote: "trag den neuen NAS in die Doku ein",
  });
  assert.equal(f.service.requests.store.get(requestId).writeAllowed, true);
  assert.equal(f.write(), true);
});

test("a mention of one member does not let another member's task write", async (t) => {
  const f = await writeGate(t);
  const other = f.store.getAssistant(f.temporary.assistantId).name;
  const { requestId } = await f.delegate(
    f.turn(`@${other} trag den NAS in die Doku ein`),
    {
      ownerRequested: false,
      ownerRequestQuote: undefined,
    },
  );
  assert.equal(f.service.requests.store.get(requestId).writeAllowed, false);
  assert.equal(f.write(), false);
});

test("a mention typed in Telegram proves the same request", async (t) => {
  const f = await writeGate(t);
  const text = `Moin!\n@${f.member.name.toLowerCase()} bitte die Firewall-Regeln dokumentieren`;
  const quote = text.slice(text.indexOf("@"));
  const telegram = { kind: "telegram", channelId: "c", chatId: "42", userId: "42" };
  const { requestId } = await f.delegate(f.turn(text, telegram), {
    ownerRequestQuote: quote,
  });
  assert.equal(f.service.requests.store.get(requestId).writeAllowed, true);
});

test("a negated, quoted or name-only mention keeps the task read-only", async (t) => {
  for (const [text, quote] of [
    ["@{name} bitte nichts ändern, nur lesen", "@{name} bitte nichts ändern"],
    ["@{name} don't touch the docs", "@{name} don't touch the docs"],
    ["@{name} trag den NAS nicht ein", "@{name} trag den NAS"],
    ['Fasse zusammen: "@{name} trag den NAS ein"', "@{name} trag den NAS ein"],
    // Without "@" the name alone is no request (no ask or delegate verb).
    ["{name} trag den neuen NAS ein", "{name} trag den neuen NAS ein"],
  ]) {
    const f = await writeGate(t);
    const fill = (value) => value.replaceAll("{name}", f.member.name);
    const { requestId } = await f.delegate(f.turn(fill(text)), {
      ownerRequestQuote: fill(quote),
    });
    const r = f.service.requests.store.get(requestId);
    assert.equal(r.writeAllowed, false, text);
    assert.equal(r.ownerProof, null, text);
    assert.equal(f.write(), false, text);
  }
});
