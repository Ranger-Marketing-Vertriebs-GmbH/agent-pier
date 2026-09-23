import test from "node:test";
import assert from "node:assert/strict";
import { apiError } from "../../web/lib/api.js";
import { setLanguage } from "../../web/lib/i18n/index.js";
import { serverProblemText, serverText } from "../../web/lib/server-messages.js";

const invalid = "Ungültige native Anfrage oder Antwort.";

test("server messages follow the active UI language by stable key", (t) => {
  t.after(() => setLanguage("de", { persist: false }));
  setLanguage("en", { persist: false });
  assert.equal(
    serverText(invalid, "requests.invalid"),
    "Invalid native request or response.",
  );
  assert.equal(
    serverText("GitHub-Download fehlgeschlagen (HTTP 503).", "tools.downloadHttpFailed", [
      "503",
    ]),
    "GitHub download failed (HTTP 503). Please try again later.",
  );
  // Text without a key is traced back through the German catalog.
  assert.equal(serverText(invalid), "Invalid native request or response.");
  // Unknown keys, unsafe arguments and free text fall back to the server text.
  assert.equal(
    serverText(invalid, "requests.missing"),
    "Invalid native request or response.",
  );
  assert.equal(serverText("Freitext", "requests.missing"), "Freitext");
  assert.equal(serverText("Freitext", "__proto__.constructor"), "Freitext");
  assert.equal(
    serverText("x", "tools.downloadHttpFailed", [{ toString: () => "evil" }]),
    "x",
  );
  assert.equal(serverText("fatal: not a git repository"), "fatal: not a git repository");
  assert.equal(
    serverProblemText(
      { type: "error", message: invalid, messageKey: "requests.invalid" },
      "",
    ),
    "Invalid native request or response.",
  );
  assert.equal(serverProblemText({}, "Request failed"), "Request failed");
  setLanguage("de", { persist: false });
  assert.equal(serverText(invalid, "requests.invalid"), invalid);
  assert.equal(serverText("Freitext", "requests.missing"), "Freitext");
});

test("API errors resolve server message keys and keep the German text otherwise", async (t) => {
  t.after(() => setLanguage("de", { persist: false }));
  const response = (body, status = 400) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  setLanguage("en", { persist: false });
  let error = await apiError(
    response({ error: invalid, messageKey: "requests.invalid" }),
  );
  assert.equal(error.message, "Invalid native request or response.");
  assert.equal(error.status, 400);
  assert.equal(error.code, undefined);
  error = await apiError(
    response({ error: "Unbekannter Fehler", messageKey: "nope.nope" }),
  );
  assert.equal(error.message, "Unbekannter Fehler");
  error = await apiError(response({}, 502));
  assert.match(error.message, /502/);
  setLanguage("de", { persist: false });
  error = await apiError(response({ error: invalid, messageKey: "requests.invalid" }));
  assert.equal(error.message, invalid);
});
