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
import { restartRequired } from "../../server/features/assistants/assistant-provider-synchronization.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

test("PDF model API is owner-only, origin-checked and says why PDFs are unavailable", async (t) => {
  const { url } = await applicationFixture(t, enabledAssistants);
  const endpoint = url + "/api/assistant-pdf-model";
  assert.equal((await fetch(endpoint)).status, 401);
  const initial = await fixtureFetch(endpoint);
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get("cache-control"), "no-store");
  assert.deepEqual(await initial.json(), { revision: 0, ready: false, reason: "notSet" });
  const options = (body, origin = url) => ({
    method: "PUT",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const missing = await fixtureFetch(
    endpoint,
    options({ revision: 0, connectionId: "missing", modelId: "vision" }),
  );
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, serverMessages.assistants.provider);
  const invalid = await fixtureFetch(endpoint, options({ revision: 0, apiKey: "x" }));
  assert.equal(invalid.status, 400);
  const foreign = await fixtureFetch(
    endpoint,
    options(
      { revision: 0, connectionId: null, modelId: null },
      "https://foreign.invalid",
    ),
  );
  assert.equal(foreign.status, 403);
  // Clearing an unset model needs no restart and only advances the revision.
  const cleared = await fixtureFetch(
    endpoint,
    options({ revision: 0, connectionId: null, modelId: null }),
  );
  assert.equal(cleared.status, 200);
  assert.deepEqual(await cleared.json(), { revision: 1, ready: false, reason: "notSet" });
});

test("saving the PDF model passes the owner's restart confirmation", async (t) => {
  const affected = { agents: [{ id: "a", name: "Home" }], teamMembers: 0 };
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use(
    assistantRoutes({
      assistantFeature: { enabled: true },
      assistants: { maintenance: false },
      assistantPdfModel: { get: () => ({ revision: 0, ready: false, reason: "notSet" }) },
      assistantWebTools: {
        async savePdfModel(input, options) {
          calls.push([input, options]);
          if (!options.confirmed)
            throw restartRequired("webToolsRestartRequired", affected);
          return { revision: 1, ...input, ready: true };
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
    fetch(`http://127.0.0.1:${server.address().port}/assistant-pdf-model`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const input = { revision: 0, connectionId: "c1", modelId: "vision" };
  const asked = await put(input);
  assert.equal(asked.status, 409);
  assert.deepEqual(await asked.json(), {
    code: "ASSISTANT_RESTART_REQUIRED",
    error: serverMessages.assistants.webToolsRestartRequired,
    affected,
    messageKey: "assistants.webToolsRestartRequired",
  });
  const saved = await put({ ...input, confirmRestart: true });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).ready, true);
  // The confirmation is never part of the saved settings.
  assert.deepEqual(calls, [
    [input, { confirmed: false }],
    [input, { confirmed: true }],
  ]);
});
