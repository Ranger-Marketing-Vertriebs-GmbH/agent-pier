import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyUpstreamError,
  messagesErrorBody,
  messagesErrorEvent,
  responsesErrorBody,
  responsesErrorStream,
} from "../../../server/features/protocol-adapter/errors.js";
import { loadFixture } from "../../helpers/protocol-adapter.js";

const SECRET_TOKEN = "sk-fixture0123456789abcdef";

test("renderers re-sanitize messages of IrErrors from other producers", () => {
  const error = {
    kind: "server",
    status: 500,
    message: `boom\nBearer abcdefghijkl ${SECRET_TOKEN}\u0007${"x".repeat(900)}`,
  };
  const rendered = [
    messagesErrorBody(error).body.error.message,
    responsesErrorBody(error).body.error.message,
    messagesErrorEvent(error),
    responsesErrorStream(error, { responseId: "resp_1", model: "m" }),
  ];
  for (const text of rendered) {
    assert.ok(!text.includes(SECRET_TOKEN));
    assert.ok(!text.includes("abcdefghijkl"));
    assert.ok(!text.includes("\u0007"));
  }
  assert.ok(messagesErrorBody(error).body.error.message.length <= 500);
  assert.ok(!messagesErrorBody(error).body.error.message.includes("\n"));
  assert.equal(
    messagesErrorBody({ kind: "server", status: 500, message: "\u0001" }).body.error
      .message,
    "server error",
  );
});

test("Responses policy codes and other rejection codes are invalid requests", () => {
  for (const code of [
    "cyber_policy",
    "bio_policy",
    "misalignment_policy_violation",
    "some_new_policy",
    "invalid_tool_schema",
    "feature_not_supported",
    "unsupported_value",
  ]) {
    const error = classifyUpstreamError({
      protocol: "responses",
      body: { type: "response.failed", response: { error: { code, message: "no" } } },
    });
    assert.equal(error.kind, "invalidRequest", code);
  }
  for (const code of ["credit_balance_exhausted", "usage_not_included"]) {
    const error = classifyUpstreamError({
      protocol: "responses",
      body: { response: { error: { code, message: "no" } } },
    });
    assert.equal(error.kind, "permission", code);
  }
  const unknown = classifyUpstreamError({
    protocol: "responses",
    body: { response: { error: { code: "something_broke", message: "no" } } },
  });
  assert.equal(unknown.kind, "server");
});

test("Messages 529 overloaded fixture: overloaded, request id not leaked", () => {
  const fixture = loadFixture("upstreams/messages/overloaded.json");
  const error = classifyUpstreamError({ protocol: "messages", ...fixture });
  assert.deepEqual(error, { kind: "overloaded", status: 529, message: "Overloaded" });
  const rendered = messagesErrorBody(error);
  assert.equal(rendered.status, 529);
  assert.deepEqual(rendered.body, {
    type: "error",
    error: { type: "overloaded_error", message: "Overloaded" },
  });
  assert.deepEqual(rendered.headers, {});
  const everything = JSON.stringify([error, rendered, responsesErrorBody(error)]);
  assert.ok(!everything.includes(fixture.headers["request-id"]));
});
