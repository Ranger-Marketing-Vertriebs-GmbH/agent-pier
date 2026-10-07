import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CAPABILITY_DEFAULTS,
  capabilityForError,
} from "../../../server/features/protocol-adapter/capabilities.js";
import { classifyUpstreamError } from "../../../server/features/protocol-adapter/errors.js";
import { createTranslator } from "../../../server/features/protocol-adapter/translate.js";

const MODEL = { modelId: "m", contextTokens: 131072, outputTokens: null, images: true };

const claudeBody = {
  model: "claude-x",
  max_tokens: 32000,
  stream: true,
  thinking: { type: "adaptive" },
  output_config: { effort: "high" },
  messages: [{ role: "user", content: "hi" }],
};

const rejection = (status, message, param) =>
  classifyUpstreamError({
    protocol: "chat",
    status,
    body: { error: { message, type: "invalid_request_error", param: param ?? null } },
  });

describe("CAPABILITY_DEFAULTS", () => {
  test("lists every capability per upstream with explicit defaults", () => {
    assert.deepEqual(CAPABILITY_DEFAULTS, {
      messages: { promptCache: true, thinkingBudget: false },
      responses: {
        promptCacheKey: false,
        reasoningEffort: true,
        parallelToolCalls: false,
      },
      chat: {
        promptCacheKey: false,
        streamUsage: true,
        reasoningEffort: false,
        parallelToolCalls: false,
        reasoningReplay: false,
        systemMessages: "merge",
        maxTokensField: "max_tokens",
      },
    });
    assert.ok(Object.isFrozen(CAPABILITY_DEFAULTS.chat));
  });
});

describe("capabilityForError", () => {
  test("Responses: reasoning and include errors switch reasoningEffort off", () => {
    for (const [message, param] of [
      [
        "Unsupported parameter: 'reasoning.effort' is not supported with this model.",
        null,
      ],
      ["Unknown parameter", "reasoning.summary"],
      ["Invalid value for 'include': reasoning.encrypted_content", null],
      ["Unsupported parameter: 'reasoning'", null],
    ]) {
      assert.deepEqual(capabilityForError("responses", rejection(400, message, param)), {
        name: "reasoningEffort",
        value: false,
      });
    }
    assert.deepEqual(
      capabilityForError("responses", rejection(422, "unknown field `prompt_cache_key`")),
      { name: "promptCacheKey", value: false },
    );
  });

  test("Chat: max_tokens, stream_options and optional parameters", () => {
    const openai =
      "Unsupported parameter: 'max_tokens' is not supported with this model. " +
      "Use 'max_completion_tokens' instead.";
    assert.deepEqual(capabilityForError("chat", rejection(400, openai)), {
      name: "maxTokensField",
      value: "max_completion_tokens",
    });
    assert.deepEqual(
      capabilityForError(
        "chat",
        rejection(400, "Unrecognized request argument: stream_options"),
      ),
      { name: "streamUsage", value: false },
    );
    assert.deepEqual(
      capabilityForError(
        "chat",
        rejection(422, "extra fields not permitted", "reasoning_effort"),
      ),
      { name: "reasoningEffort", value: false },
    );
    assert.deepEqual(
      capabilityForError("chat", rejection(400, "unknown field: parallel_tool_calls")),
      { name: "parallelToolCalls", value: false },
    );
  });

  test("Messages: adaptive thinking not supported switches to the budget table", () => {
    const error = classifyUpstreamError({
      protocol: "messages",
      status: 400,
      body: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "adaptive thinking is not supported on this model",
        },
      },
    });
    assert.deepEqual(capabilityForError("messages", error), {
      name: "thinkingBudget",
      value: true,
    });
  });

  test("other errors propose nothing", () => {
    assert.equal(capabilityForError("chat", rejection(400, "messages: bad role")), null);
    assert.equal(
      capabilityForError("chat", rejection(500, "max_tokens is not supported")),
      null,
    );
    assert.equal(
      capabilityForError("responses", rejection(400, "your prompt must include text")),
      null,
    );
    const context = rejection(400, "maximum context length is 8192 tokens");
    assert.equal(capabilityForError("chat", context), null);
    assert.equal(capabilityForError("chat", null), null);
  });

  test("false positives: wordings that only quote a parameter propose nothing", () => {
    for (const [upstream, message, param] of [
      // Chat: value errors about max_tokens are not a field-name problem.
      ["chat", "max_tokens is too large: 50000. This model supports at most 4096.", null],
      ["chat", "max_tokens must be at least 1", "max_tokens"],
      ["chat", "max_completion_tokens is too large: 50000", "max_completion_tokens"],
      // Responses: item ordering and schema errors quoting 'reasoning' or 'include'.
      [
        "responses",
        "Item 'rs_1' of type 'reasoning' was provided without its required following item.",
        "input",
      ],
      [
        "responses",
        "Item 'rs_1' of type 'reasoning' was provided without its required following item.",
        null,
      ],
      [
        "responses",
        "Invalid schema for function 'search': 'include' is not valid under any of the given schemas.",
        "tools[0].parameters",
      ],
      ["responses", "Invalid value for 'include' in tool 'search' arguments", null],
      ["responses", "Unsupported content type 'reasoning' in message input", null],
      // Responses: value errors keep reasoning on (only the value is wrong).
      [
        "responses",
        "Unsupported value: 'reasoning.effort' does not support 'minimal' with this " +
          "model. Supported values are: 'low', 'medium', and 'high'.",
        "reasoning.effort",
      ],
      [
        "responses",
        "Invalid value: 'ultra'. Supported values are: 'low'.",
        "reasoning.effort",
      ],
      // Messages: any message containing "adaptive" is not an adaptive-thinking rejection.
      [
        "messages",
        "max_tokens must be greater than 1024 when using adaptive thinking",
        null,
      ],
      ["messages", "output_config.effort: adaptive value 'ultra' is invalid", null],
    ]) {
      assert.equal(
        capabilityForError(upstream, rejection(400, message, param)),
        null,
        `${upstream}: ${message}`,
      );
    }
  });

  test("Chat: Missing reasoning_content turns reasoning replay on", () => {
    const deepseek =
      "Missing `reasoning_content` field in the assistant message at message index 2.";
    assert.deepEqual(capabilityForError("chat", rejection(400, deepseek)), {
      name: "reasoningReplay",
      value: true,
    });
    assert.deepEqual(
      capabilityForError("chat", rejection(400, "Unrecognized field: reasoning_content")),
      { name: "reasoningReplay", value: false },
    );
  });

  test("Chat: unsupported max_completion_tokens switches back to max_tokens", () => {
    const reverse =
      "Unsupported parameter: 'max_completion_tokens' is not supported with this model. " +
      "Use 'max_tokens' instead.";
    for (const param of ["max_completion_tokens", null]) {
      assert.deepEqual(capabilityForError("chat", rejection(400, reverse, param)), {
        name: "maxTokensField",
        value: "max_tokens",
      });
    }
    const forward =
      "Unsupported parameter: 'max_tokens' is not supported with this model. " +
      "Use 'max_completion_tokens' instead.";
    assert.deepEqual(capabilityForError("chat", rejection(400, forward, "max_tokens")), {
      name: "maxTokensField",
      value: "max_completion_tokens",
    });
    assert.deepEqual(
      capabilityForError(
        "chat",
        rejection(400, "Unrecognized request argument supplied: max_completion_tokens"),
      ),
      { name: "maxTokensField", value: "max_tokens" },
    );
  });

  test("Messages: adaptive thinking.type tag rejection switches to the budget table", () => {
    const message =
      "thinking.type: Input tag 'adaptive' found using 'type' does not match any of the " +
      "expected tags: 'disabled', 'enabled'";
    assert.deepEqual(capabilityForError("messages", rejection(400, message)), {
      name: "thinkingBudget",
      value: true,
    });
  });
});

describe("translator capabilities", () => {
  test("defaults apply per upstream and explicit values override them", () => {
    const chat = createTranslator({ client: "messages", upstream: "chat", model: MODEL });
    const body = chat.buildUpstream(claudeBody, {}, { requestId: "r1" }).request.body;
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.max_tokens, 32000);

    const opted = createTranslator({
      client: "messages",
      upstream: "chat",
      model: MODEL,
      capabilities: { reasoningEffort: true, maxTokensField: "max_completion_tokens" },
    });
    const optedBody = opted.buildUpstream(claudeBody, {}, { requestId: "r2" }).request
      .body;
    assert.equal(optedBody.reasoning_effort, "high");
    assert.equal(optedBody.max_completion_tokens, 32000);
    assert.equal(optedBody.max_tokens, undefined);
  });

  test("setCapability affects subsequent requests only", () => {
    const instance = createTranslator({
      client: "messages",
      upstream: "responses",
      model: MODEL,
    });
    const first = instance.buildUpstream(claudeBody, {}, { requestId: "r1" });
    assert.ok(first.request.body.reasoning);
    instance.setCapability("reasoningEffort", false);
    const second = instance.buildUpstream(claudeBody, {}, { requestId: "r2" });
    assert.equal(second.request.body.reasoning, undefined);
    assert.equal(second.request.body.include, undefined);
    assert.ok(first.request.body.reasoning, "an already built request is unchanged");
  });

  test("setCapability validates name and value", () => {
    const instance = createTranslator({
      client: "messages",
      upstream: "chat",
      model: MODEL,
    });
    assert.throws(() => instance.setCapability("thinkingBudget", true), TypeError);
    assert.throws(() => instance.setCapability("streamUsage", "no"), TypeError);
    assert.throws(() => instance.setCapability("maxTokensField", "max"), TypeError);
    instance.setCapability("maxTokensField", "max_completion_tokens");
    const body = instance.buildUpstream(claudeBody, {}, { requestId: "r" }).request.body;
    assert.equal(body.max_completion_tokens, 32000);
  });

  test("invalid capability values are rejected at creation, unknown names ignored", () => {
    assert.throws(
      () =>
        createTranslator({
          client: "messages",
          upstream: "chat",
          model: MODEL,
          capabilities: { systemMessages: "first" },
        }),
      TypeError,
    );
    const instance = createTranslator({
      client: "responses",
      upstream: "chat",
      model: MODEL,
      capabilities: { thinkingBudget: true, futureFlag: 1 },
    });
    assert.equal(typeof instance.buildUpstream, "function");
  });
});
