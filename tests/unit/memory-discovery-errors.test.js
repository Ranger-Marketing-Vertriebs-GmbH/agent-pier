import test from "node:test";
import assert from "node:assert/strict";
import api from "../../web/lib/api.js";
import { setLanguage } from "../../web/lib/i18n/index.js";

test("Memory discovery launch errors use a stable code and the active UI language", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({
    ok: false,
    status: 409,
    json: async () => ({
      code: "MEMORY_DISCOVERY_CONFIG",
      error: "Untranslated diagnostic",
    }),
  }));
  t.after(() => setLanguage("de", { persist: false }));
  setLanguage("en", { persist: false });
  await assert.rejects(
    api("/sessions", "POST", {}),
    /Memory discovery hooks could not be configured/,
  );
  setLanguage("de", { persist: false });
  await assert.rejects(
    api("/sessions", "POST", {}),
    /Memory-Hooks konnten nicht konfiguriert werden/,
  );
});
