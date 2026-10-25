import test from "node:test";
import assert from "node:assert/strict";
import { secrets as english } from "../../server/lib/i18n/en/secrets.js";
import { apiError } from "../../web/lib/api.js";
import { setLanguage } from "../../web/lib/i18n/index.js";
import { applicationFixture } from "../helpers/application.js";

// The real server's refusals, read by the browser's apiError in English.
async function englishError(f, body) {
  const response = await f.request("/api/secrets", { method: "POST", body });
  const payload = await response.text();
  return apiError(
    new Response(payload, {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

test("every SECRET_INVALID text of the server reaches the English UI translated", async (t) => {
  t.after(() => setLanguage("de", { persist: false }));
  setLanguage("en", { persist: false });
  const f = await applicationFixture(t);
  const cases = [
    [{ name: "lower", value: "v" }, english.invalidName],
    [{ name: "A", description: "x".repeat(201), value: "v" }, english.invalidDescription],
    [{ name: "A", value: "" }, english.invalidValue],
    [{ name: "A", projectId: "p".repeat(121), value: "v" }, english.invalidProject],
    [{ name: "A", value: "v", extra: 1 }, english.invalidBody],
  ];
  for (const [body, text] of cases) {
    const error = await englishError(f, body);
    assert.equal(error.code, "SECRET_INVALID");
    assert.equal(error.message, text);
  }
  await englishError(f, { name: "TAKEN", value: "v" });
  const taken = await englishError(f, { name: "TAKEN", value: "v" });
  assert.equal(taken.code, "SECRET_NAME_TAKEN");
  assert.equal(taken.message, "A secret with this name already exists.");
});
