import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mcpServerRoutes } from "../../server/http/routes/mcp-servers.js";
import { registerResponses } from "../../server/http/responses.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { assistantProblem } from "../../server/features/assistants/assistant-validation.js";

async function withList(fail) {
  const app = express();
  const services = {
    mcpServerChanges: {
      list() {
        throw fail();
      },
    },
    audit: { append() {} },
  };
  app.use("/api", mcpServerRoutes(services));
  registerResponses(app);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.map(String).join(" "));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/mcp-servers?token=secret-query`,
    );
    return { response, body: await response.json(), logged };
  } finally {
    console.error = original;
    server.close();
  }
}

test("an unexpected error is a logged generic 500, not an unready service", async () => {
  const { response, body, logged } = await withList(
    () => new TypeError("secret-header-value is not a function"),
  );
  assert.equal(response.status, 500);
  assert.equal(body.error, serverMessages.http.internalError);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /TypeError/);
  assert.match(logged[0], /secret-header-value is not a function/);
  assert.doesNotMatch(logged[0], /secret-query|token=/);
  assert.doesNotMatch(JSON.stringify(body), /secret-header-value/);
});

test("a readiness failure stays 503 unavailable and is not logged", async () => {
  const { response, body, logged } = await withList(() =>
    Object.assign(Error("Assistant Gateway unavailable (UNAVAILABLE)."), {
      code: "UNAVAILABLE",
      status: 503,
    }),
  );
  assert.equal(response.status, 503);
  assert.equal(body.error, serverMessages.assistants.unavailable);
  assert.deepEqual(logged, []);
});

test("an error below 500 keeps its status and reason", async () => {
  const { response, body, logged } = await withList(() => assistantProblem("invalid"));
  assert.equal(response.status, 400);
  assert.equal(body.error, serverMessages.assistants.invalid);
  assert.deepEqual(logged, []);
});

test("a Gateway reply stays 503 unavailable without logging its private text", async () => {
  const { response, body, logged } = await withList(() =>
    Object.assign(Error("private gateway detail"), {
      code: "INVALID_REQUEST",
      status: 400,
      answered: true,
    }),
  );
  assert.equal(response.status, 503);
  assert.equal(body.error, serverMessages.assistants.unavailable);
  assert.deepEqual(logged, []);
  assert.doesNotMatch(JSON.stringify(body), /private gateway detail/);
});
