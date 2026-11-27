import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import { shellGateway } from "../helpers/assistant-shell-gateway.js";
import { grantedToolNames } from "../helpers/assistant-model-server.js";
import { createGatewaySession } from "../../server/features/assistants/runtimes/openclaw/session-create.js";
import { recallTools } from "../../server/features/assistants/native-capabilities.js";

// What the pinned Gateway does with the read-only session tools AgentPier grants an
// agent with memory (native-capabilities.js recallTools) under the visibility it
// compiles for every Gateway (`tools.sessions.visibility: "agent"`,
// runtime-config.js): an agent finds and reads its own earlier chats, never another
// agent's, and a chat deleted with its transcript (chat-removal.js) is gone.
const installed = process.env.AGENTPIER_SHELL_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_SHELL_CONTRACT_RUNTIME",
  timeout: contractTimeout(300000),
};
const secret = "PELIKAN";

test(
  "an agent with the recall tools reads its own earlier chats and no other agent's",
  options,
  async (t) => {
    const gw = await shellGateway(t, installed, { prefix: "chat-recall-contract-" });
    const allow = ["session_status", ...recallTools];
    const other = await gw.agent("other");
    const plain = await gw.agent("plain");
    await gw.configure({
      // As compileOpenClawConfig writes them: the global list is the upper bound, each
      // agent's entry decides who holds the tools.
      tools: { allow, sessions: { visibility: "agent" } },
      agents: {
        entries: {
          main: { tools: { allow } },
          [other]: { tools: { allow } },
          [plain]: { tools: { allow: ["session_status"] } },
        },
      },
    });
    // One turn of `agentId` in a new chat, in which the model calls `call` once (or
    // only answers): the session, the tools it was offered and the call's result.
    const turn = async (agentId, label, message, call) => {
      gw.tool.name = call?.name ?? "none";
      gw.tool.arguments = call?.arguments ?? {};
      const from = gw.model.requests.length;
      const session = await createGatewaySession(gw.client, { agentId, label });
      const { runId } = await gw.client.call("sessions.send", {
        key: session.key,
        message,
        idempotencyKey: label,
      });
      const done = await gw.client.call(
        "agent.wait",
        { runId, timeoutMs: 60000 },
        { timeoutMs: 65000 },
      );
      assert.equal(done.status, "ok", label);
      const requests = gw.model.requests.slice(from);
      return {
        session,
        offered: grantedToolNames(requests[0]),
        result: requests
          .flatMap((r) => r.messages || [])
          .filter((m) => m.role === "tool")
          .map((m) => String(m.content))
          .at(-1),
      };
    };
    const search = (agentId, label) =>
      turn(agentId, label, "What did we say?", {
        name: "sessions_search",
        arguments: { query: secret },
      });
    const history = (agentId, label, sessionKey) =>
      turn(agentId, label, "Read it.", {
        name: "sessions_history",
        arguments: { sessionKey },
      });

    // The chat to recall: main's, with a word no other chat holds.
    const earlier = await turn("main", "earlier", `The harbour word is ${secret}.`);
    for (const tool of recallTools) assert.ok(earlier.offered.includes(tool), tool);
    // No tool that runs, steers or changes a session is offered.
    for (const tool of ["sessions_send", "sessions_spawn", "sessions", "sessions_create"])
      assert.equal(earlier.offered.includes(tool), false, tool);

    // The same agent, in another chat, finds the passage and reads the chat.
    const found = await search("main", "main-search");
    t.diagnostic(`own search: ${found.result?.slice(0, 600)}`);
    assert.ok(found.result.includes(secret), found.result);
    assert.ok(found.result.includes(earlier.session.key), found.result);
    const read = await history("main", "main-history", earlier.session.key);
    assert.ok(read.result.includes(`The harbour word is ${secret}.`), read.result);
    const listed = await turn("main", "main-list", "Which chats?", {
      name: "sessions_list",
      arguments: {},
    });
    assert.ok(listed.result.includes(earlier.session.key), listed.result);

    // Another agent holds the same tools and reaches none of it: no hit, no
    // transcript, no row.
    const foreign = await search(other, "other-search");
    t.diagnostic(`foreign search: ${foreign.result?.slice(0, 600)}`);
    assert.equal(foreign.result.includes(earlier.session.key), false, foreign.result);
    assert.equal(foreign.result.includes("harbour"), false, foreign.result);
    const refused = await history(other, "other-history", earlier.session.key);
    t.diagnostic(`foreign history: ${refused.result?.slice(0, 600)}`);
    assert.equal(refused.result.includes(secret), false, refused.result);
    assert.match(refused.result, /visibility is restricted|forbidden/i);
    const others = await turn(other, "other-list", "Which chats?", {
      name: "sessions_list",
      arguments: {},
    });
    assert.equal(others.result.includes(earlier.session.key), false, others.result);
    assert.equal(others.result.includes("agent:main:"), false, others.result);

    // An agent whose entry leaves the tools out (memory off) is offered none.
    const without = await search(plain, "plain-search");
    for (const tool of recallTools)
      assert.equal(without.offered.includes(tool), false, tool);
    assert.equal(without.result, undefined);

    // A chat the owner deleted is deleted with its transcript: nothing to recall.
    await gw.client.call("sessions.delete", {
      key: earlier.session.key,
      deleteTranscript: true,
    });
    // The searches above are chats of their own that quote the word; only the
    // deleted chat's own sentence must be gone.
    const after = await turn("main", "main-after", "And now?", {
      name: "sessions_search",
      arguments: { query: "harbour" },
    });
    t.diagnostic(`after delete: ${after.result?.slice(0, 600)}`);
    assert.equal(after.result.includes(earlier.session.key), false, after.result);
    assert.equal(after.result.includes("harbour word"), false, after.result);
    const gone = await history("main", "main-gone", earlier.session.key);
    assert.equal(gone.result.includes("harbour word"), false, gone.result);
  },
);
