import test from "node:test";
import assert from "node:assert/strict";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import {
  collectEvents,
  endsRun,
  hermesSandbox,
  hermesSkip,
  startHermes,
  strayAfterStop,
} from "../helpers/hermes-native.js";

// The Hermes models sub-port and a model connection of another endpoint kind than
// the plain Bearer endpoint the other contracts use, against the pinned Hermes as
// AgentPier runs it (hermes-native.js): an Azure-style endpoint that takes its key in
// an `api-key` header and refuses `stream_options`, as an endpoint whose Chat
// Completions options turn streamUsage off. Hermes needs no setting for either
// (hermes-config/model.js): it sends the key only in the header AgentPier compiled,
// retries without the usage extension, and caps no output on an agent's turn.
const options = { skip: hermesSkip, timeout: contractTimeout(600000) };
const agentId = "hermes-models";

test(
  "Hermes contract: an api-key endpoint without stream usage runs a turn; models report the home",
  options,
  async (t) => {
    const model = await startFakeModel({ rejectStreamOptions: true });
    t.after(() => model.close());
    const dirs = hermesSandbox(t);
    const { sessions, events, runtime, stop } = await startHermes(t, dirs, {
      agentId,
      model: {
        baseUrl: model.baseUrl,
        provider: {
          authHeader: false,
          headers: { authorization: "", "api-key": "contract-key" },
        },
      },
    });
    const { key } = await sessions.create({
      agentId,
      label: "models",
      idempotencyKey: "m1",
    });
    const run = collectEvents(events);
    await sessions.send({
      key,
      turn: { message: "hello azure" },
      idempotencyKey: "run-m1",
    });
    const end = await run.until(endsRun("run-m1"));
    assert.equal(end.kind, "finished");
    assert.equal(end.payload.text, "ECHO: hello azure");
    const turns = model.requests.filter((r) => r.url.endsWith("/chat/completions"));
    assert.ok(turns.length >= 2, "the refused stream was repeated");
    // The key travels in the api-key header alone, never as a Bearer credential.
    for (const { headers } of turns) {
      assert.equal(headers["api-key"], "contract-key");
      assert.doesNotMatch(String(headers.authorization || ""), /contract-key/);
    }
    // Refused once with the usage extension, then streamed without it.
    assert.ok(turns[0].body.stream_options);
    const answered = turns.at(-1).body;
    assert.equal(answered.stream, true);
    assert.equal(answered.stream_options, undefined);
    // No output cap on the agent's turn, so maxTokensField has nothing to name.
    for (const { body } of turns) {
      assert.equal(body.max_tokens, undefined);
      assert.equal(body.max_completion_tokens, undefined);
    }
    // The models sub-port: Hermes's inventory of the home, no accounts.
    assert.equal(runtime.capabilities().models.available, true);
    const catalog = await runtime.models.catalog({ timeoutMs: 60000 });
    assert.equal(typeof catalog, "object");
    assert.deepEqual(await runtime.models.status({ timeoutMs: 10000 }), {
      providers: [],
    });
    await assert.rejects(
      runtime.models.login({ sessionId: "s1", authChoice: "openai-codex" }),
      (e) => e.code === "UNSUPPORTED",
    );
    run.unsubscribe();
    await stop();
    assert.deepEqual(await strayAfterStop(dirs), []);
  },
);
