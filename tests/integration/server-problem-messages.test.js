import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { registerResponses } from "../../server/http/responses.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { requestCopy } from "../../server/lib/i18n/de/requests.js";
import { messageIdentity } from "../../server/lib/i18n/message-identity.js";
import { problem } from "../../server/lib/storage.js";

test("message identity names the catalog key and interpolation arguments", () => {
  assert.deepEqual(messageIdentity(requestCopy.invalid), {
    messageKey: "requests.invalid",
  });
  assert.deepEqual(messageIdentity(serverMessages.tools.downloadHttpFailed(502)), {
    messageKey: "tools.downloadHttpFailed",
    messageArgs: ["502"],
  });
  // The longer literal wins when a shorter template would also accept the text.
  assert.deepEqual(messageIdentity(serverMessages.chat.cliUnavailableOnHost("Codex")), {
    messageKey: "chat.cliUnavailableOnHost",
    messageArgs: ["Codex"],
  });
  assert.deepEqual(messageIdentity("codex: command not found"), {});
  assert.deepEqual(messageIdentity(""), {});
  assert.deepEqual(messageIdentity(undefined), {});
});

test("problem responses keep German text and add stable message keys", async (t) => {
  const app = express();
  app.use(express.json());
  app.post("/api/answer", () => {
    throw problem(requestCopy.invalid, 400);
  });
  app.get("/api/download", () => {
    throw problem(serverMessages.tools.downloadHttpFailed(503), 409);
  });
  app.get("/api/native", () => {
    throw problem("fatal: not a git repository", 409);
  });
  app.get("/api/crash", () => {
    throw Object.assign(new Error("private stack detail"), { status: 500 });
  });
  registerResponses(app);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = async (path, init) => {
    const response = await fetch(base + path, init);
    return [response.status, await response.json()];
  };
  assert.deepEqual(await body("/api/answer", { method: "POST" }), [
    400,
    { error: requestCopy.invalid, messageKey: "requests.invalid" },
  ]);
  assert.deepEqual(await body("/api/download"), [
    409,
    {
      error: serverMessages.tools.downloadHttpFailed(503),
      messageKey: "tools.downloadHttpFailed",
      messageArgs: ["503"],
    },
  ]);
  // Native CLI output keeps its original language and has no key.
  assert.deepEqual(await body("/api/native"), [
    409,
    { error: "fatal: not a git repository" },
  ]);
  assert.deepEqual(await body("/api/crash"), [
    500,
    { error: serverMessages.http.internalError, messageKey: "http.internalError" },
  ]);
  assert.deepEqual(
    await body("/api/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    }),
    [400, { error: serverMessages.http.invalidJson, messageKey: "http.invalidJson" }],
  );
  assert.deepEqual(await body("/api/missing"), [
    404,
    { error: serverMessages.http.notFound, messageKey: "http.notFound" },
  ]);
});
