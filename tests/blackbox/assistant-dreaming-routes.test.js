import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import {
  applicationFixture,
  enabledAssistants,
  fixtureFetch,
} from "../helpers/application.js";
import { assistantRoutes } from "../../server/http/routes/assistants.js";
import { assistantProblem } from "../../server/features/assistants/assistant-validation.js";
import {
  DREAMING_AGENTS_BUSY,
  DREAMING_MEMORY_CONFIRMATION_REQUIRED,
} from "../../server/features/assistants/dreaming-service.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

test("the dreaming API is owner-only and starts switched off", async (t) => {
  const { url } = await applicationFixture(t, enabledAssistants);
  const endpoint = url + "/api/assistant-dreaming";
  assert.equal((await fetch(endpoint)).status, 401);
  const initial = await fixtureFetch(endpoint);
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get("cache-control"), "no-store");
  const body = await initial.json();
  assert.equal(body.enabled, false);
  assert.equal(body.hour, 3);
  assert.ok(Array.isArray(body.withoutMemory));
  const invalid = await fixtureFetch(endpoint, {
    method: "PUT",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ revision: body.revision, enabled: true, hour: 24 }),
  });
  assert.equal(invalid.status, 400);
});

test("a 409 naming agents carries them and its code", async (t) => {
  const agents = [{ id: "b", name: "B" }];
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use(
    assistantRoutes({
      assistantFeature: { enabled: true },
      assistants: { maintenance: false },
      assistantDreaming: {
        async save(input, revision) {
          calls.push([input, revision]);
          if (input.hour === 4)
            throw Object.assign(assistantProblem("dreamingAgentsBusy", 409), {
              code: DREAMING_AGENTS_BUSY,
              agents,
            });
          if (input.confirmMemory !== true)
            throw Object.assign(assistantProblem("dreamingMemoryConfirm", 409), {
              code: DREAMING_MEMORY_CONFIRMATION_REQUIRED,
              agents,
            });
          return { revision: revision + 1, ...input, withoutMemory: [] };
        },
      },
    }),
  );
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message, key: error.key }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const put = (body) =>
    fetch(`http://127.0.0.1:${server.address().port}/assistant-dreaming`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const input = { enabled: true, hour: 3, timeZone: "Europe/Berlin" };
  const asked = await put({ ...input, revision: 1 });
  assert.equal(asked.status, 409);
  assert.deepEqual(await asked.json(), {
    code: DREAMING_MEMORY_CONFIRMATION_REQUIRED,
    error: serverMessages.assistants.dreamingMemoryConfirm,
    agents,
    messageKey: "assistants.dreamingMemoryConfirm",
  });
  const busy = await put({ ...input, hour: 4, confirmMemory: true, revision: 1 });
  assert.equal(busy.status, 409);
  assert.deepEqual(await busy.json(), {
    code: DREAMING_AGENTS_BUSY,
    error: serverMessages.assistants.dreamingAgentsBusy,
    agents,
    messageKey: "assistants.dreamingAgentsBusy",
  });
  const saved = await put({ ...input, confirmMemory: true, revision: 1 });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, 2);
  // The revision travels apart from the setting.
  assert.deepEqual(calls[0], [input, 1]);
});
