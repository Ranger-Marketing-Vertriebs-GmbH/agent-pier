import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import {
  observeClaude,
  observeCodex,
  observeOpenCode,
} from "../../server/features/chat/chat-observability.js";

test("generated request histories report the last input once without cumulative or duplicate-cache inflation", () => {
  const usage = fc.record({
    input: fc.integer({ min: 0, max: 1000000 }),
    read: fc.integer({ min: 0, max: 1000000 }),
    write: fc.integer({ min: 0, max: 1000000 }),
    output: fc.integer({ min: 0, max: 1000000 }),
  });
  check(
    fc.property(fc.array(usage, { minLength: 1, maxLength: 40 }), (history) => {
      const last = history.at(-1),
        expected = last.input + last.read + last.write;
      const claude = history.map((u, i) => ({
        type: "assistant",
        timestamp: 1000 + i,
        message: {
          id: `message-${i}`,
          usage: {
            input_tokens: u.input,
            cache_read_input_tokens: u.read,
            cache_creation_input_tokens: u.write,
            output_tokens: u.output,
          },
        },
      }));
      const codex = history.map((u) => ({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 999999999 },
            last_token_usage: {
              input_tokens: u.input + u.read + u.write,
              total_tokens: u.input + u.read + u.write + u.output,
              cached_input_tokens: u.read,
              output_tokens: u.output,
            },
            model_context_window: 4000000,
          },
        },
      }));
      const opencode = {
        messages: history.map((u) => ({
          info: {
            role: "assistant",
            time: { completed: 1000 },
            tokens: {
              input: u.input,
              output: u.output,
              cache: { read: u.read, write: u.write },
            },
          },
          parts: [],
        })),
      };
      for (const observed of [observeClaude(claude), observeOpenCode(opencode)])
        assert.equal(observed.context.usedTokens, expected);
      assert.equal(observeCodex({}, codex).context.usedTokens, expected + last.output);
    }),
  );
});
test("arbitrary JSON content cannot create native usage or agent records from prose", () => {
  check(
    fc.property(fc.jsonValue(), (value) => {
      const prose = JSON.stringify(value);
      for (const observed of [
        observeClaude([{ type: "assistant", message: { content: prose } }]),
        observeCodex({ turns: [{ items: [{ type: "agentMessage", text: prose }] }] }),
        observeOpenCode({
          messages: [
            { info: { role: "assistant" }, parts: [{ type: "text", text: prose }] },
          ],
        }),
      ]) {
        assert.equal(observed.context.usedTokens, null);
        assert.deepEqual(observed.subagents, []);
      }
    }),
  );
});
