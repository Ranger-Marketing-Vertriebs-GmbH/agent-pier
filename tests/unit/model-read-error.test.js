import test from "node:test";
import assert from "node:assert/strict";
import { modelReadError } from "../../web/features/models/model-read-error.js";
import { serverMessagesReady } from "../../web/lib/server-messages.js";
import { setLanguage } from "../../web/lib/i18n/index.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

test("a model read refusal shows in the UI language", async (t) => {
  t.after(() => setLanguage("de"));
  setLanguage("en");
  await serverMessagesReady();
  assert.equal(modelReadError({ code: "stopped" }), "The session has stopped.");
  assert.equal(
    modelReadError({ code: "shell" }),
    "Model selection is not available in shell sessions.",
  );
  assert.equal(
    modelReadError({ code: "login" }),
    "Model selection is not available during sign-in.",
  );
  assert.equal(modelReadError({ code: "reloading" }), "The session is reloading.");
  // Another refusal's German server text is translated too.
  const other = modelReadError({
    code: "unavailable",
    message: serverMessages.sessions.stopped,
  });
  assert.equal(other, "The session has stopped.");
  assert.equal(
    modelReadError({ code: "unavailable" }),
    "The model status is not available right now.",
  );
  setLanguage("de");
  assert.equal(modelReadError({ code: "stopped" }), "Die Session ist beendet.");
});
