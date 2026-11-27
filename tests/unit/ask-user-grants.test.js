import test from "node:test";
import assert from "node:assert/strict";
import {
  lockedTools,
  profileTools,
  questionTools,
  routineTools,
  senderLockedTools,
} from "../../server/features/assistants/native-capabilities.js";
import { hookTools } from "../../server/features/assistants/agent-hook-rights.js";
import { nativeTools } from "../../server/features/assistants/runtimes/openclaw/runtime-config.js";
import { lockedCoreTools } from "../../server/features/assistants/team-plugin/tool-guard.js";
import { lockedEntry } from "../../server/features/users/user-agent-lock.js";

// Who holds OpenClaw's ask_user (a question to the owner that waits for the answer,
// agent-questions.js): an owner's own agent in its chat, and nobody whose question
// could reach no one or the wrong person.
const holds = (assistant, nativeReady = true) =>
  profileTools(assistant, true, nativeReady, true).includes("ask_user");
const userAccess = { mode: "own", members: [{ userId: "u1", level: "chat" }] };

test("an owner's own agent may ask the owner; members and user agents may not", () => {
  assert.deepEqual(questionTools, ["ask_user"]);
  assert.equal(holds({ id: "a1" }), true);
  // Only where AgentPier's native tools run, which show and answer the question.
  assert.equal(holds({ id: "a1" }, false), false);
  assert.equal(holds({ id: "a1", archivedAt: 1 }), false);
  // A team member reports to its lead, permanent or temporary.
  assert.equal(holds({ id: "m1", teamMemberId: "t1", lifetime: "permanent" }), false);
  assert.equal(
    holds({ id: "m2", teamMemberId: "t1", inherited: { capabilities: {} } }),
    false,
  );
  // A restricted user's chat has no question card: locked and denied.
  assert.equal(holds({ id: "u1", userAccess }), false);
  assert.equal(holds({ id: "u2", userAccess: { ...userAccess, mode: "shared" } }), false);
  assert.ok(lockedTools.includes("ask_user"));
  assert.ok(lockedCoreTools.includes("ask_user"));
  const locked = lockedEntry(
    { tools: { allow: ["read", "ask_user"] } },
    { id: "u1", userAccess },
  );
  assert.deepEqual(locked.tools.allow, ["read"]);
  assert.ok(locked.tools.deny.includes("ask_user"));
});

test("no bot for other people, routine or hook run asks the owner", () => {
  // The compiled entry of an agent with its own bot drops senderLockedTools.
  assert.ok(senderLockedTools.includes("ask_user"));
  // Nobody is there to answer a routine's or a hook's run.
  assert.equal(routineTools.includes("ask_user"), false);
  const everything = {
    research: true,
    coding: true,
    mail: true,
    memory: true,
    mcp: true,
    shell: "full",
    folders: { p1: "write" },
    sshHosts: ["h1"],
  };
  const hook = hookTools(everything, { webSearch: true, webFetch: true });
  assert.ok(hook.includes("agentpier_card"));
  assert.equal(hook.includes("ask_user"), false);
  // The Gateway's global allow list names it, so an agent's entry can grant it.
  assert.ok(nativeTools.includes("ask_user"));
});
