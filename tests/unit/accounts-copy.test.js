import test from "node:test";
import assert from "node:assert/strict";
import * as de from "../../web/lib/i18n/de/accounts.js";
import * as en from "../../web/lib/i18n/en/accounts.js";
import { accountsHubCopy } from "../../web/lib/i18n/messages/accounts.js";
import { setLanguage } from "../../web/lib/i18n/index.js";

test("the accounts hub copy exists in German and English", () => {
  for (const catalog of [de, en]) {
    const copy = catalog.accountsHubCopy;
    assert.equal(typeof copy.intro, "string");
    assert.deepEqual(Object.keys(copy.groups).sort(), [
      "cli",
      "mcpServers",
      "models",
      "services",
    ]);
    assert.match(copy.restartsAgents(2), /2/);
    assert.match(copy.restartsAgents(1), /1/);
    assert.match(copy.sessionsCount(3), /3/);
    assert.match(copy.breadcrumb("X"), /X/);
    assert.match(copy.chatgptSub("Y"), /Y/);
  }
});

test("the accounts hub copy follows the UI language", () => {
  setLanguage("en");
  assert.equal(accountsHubCopy.groups.models, "Model access");
  assert.equal(accountsHubCopy.restartsAgents(2), "Briefly restarts 2 agents.");
  setLanguage("de");
  assert.equal(accountsHubCopy.groups.models, "Modell-Zugänge");
  assert.equal(accountsHubCopy.restartsAgents(2), "Startet 2 Agenten kurz neu.");
});
