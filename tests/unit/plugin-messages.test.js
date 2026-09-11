import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import { catalogReason, pluginNote } from "../../web/features/plugins/plugin-messages.js";

test("plugin messages keep unknown or older server diagnostics intact", () => {
  setLanguage("en");
  for (const code of [undefined, "future-code", "toString", "__proto__"])
    assert.equal(
      catalogReason({ catalogReasonCode: code, catalogReason: "Original diagnostic" }),
      "Original diagnostic",
    );
  for (const codes of [undefined, [], "restartRequired", ["restartRequired", "future"]])
    assert.equal(
      pluginNote({ noteCodes: codes, note: "Original notice" }),
      "Original notice",
    );
});

test("coded plugin messages resolve the active language when it changes", () => {
  const data = {
    catalogReasonCode: "unavailable",
    noteCodes: ["restartRequired", "codexActivation"],
  };
  setLanguage("en");
  assert.match(catalogReason(data), /Local plugins remain available/);
  assert.match(pluginNote(data), /Changes apply to new CLI sessions/);
  setLanguage("de");
  assert.match(catalogReason(data), /Lokale Plugins bleiben verfügbar/);
  assert.match(pluginNote(data), /Änderungen gelten für neue CLI-Sitzungen/);
});

test("Claude and OpenCode plugin notices are also localized", () => {
  setLanguage("en");
  assert.match(
    pluginNote({ noteCodes: ["restartRequired", "claudeMarketplaceRemoval"] }),
    /Removing a marketplace uninstalls its plugins in Claude/,
  );
  assert.match(
    pluginNote({ noteCodes: ["openCodeConfiguration"] }),
    /OpenCode uses npm packages and local plugins/,
  );
  setLanguage("de");
});
