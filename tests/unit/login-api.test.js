import test from "node:test";
import assert from "node:assert/strict";
import { loginRequest } from "../../web/features/login/login-api.js";
import { setLanguage } from "../../web/lib/i18n/index.js";

test("login errors translate stable codes with the active catalog and hide unknown messages", async (t) => {
  let code = "LOGIN_CREDENTIALS_INVALID";
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(JSON.stringify({ code, error: "private diagnostic" }), {
        status: 401,
      }),
  );
  t.after(() => setLanguage("de"));
  setLanguage("en");
  await assert.rejects(loginRequest("login", {}), {
    message: "Username or password is incorrect.",
  });
  setLanguage("de");
  await assert.rejects(loginRequest("login", {}), {
    message: "Benutzername oder Passwort ist falsch.",
  });
  setLanguage("en");
  code = "UNKNOWN";
  await assert.rejects(loginRequest("login", {}), {
    message: "Could not check sign-in.",
  });
});
