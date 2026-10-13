import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import { assistantCopy } from "../../web/lib/i18n/messages/assistants.js";
import { assistantChannelCopy } from "../../web/lib/i18n/messages/assistant-channel.js";
import { assistantTeamCopy } from "../../web/lib/i18n/messages/assistant-team.js";
import { assistantCopy as germanCopy } from "../../web/lib/i18n/de/assistants.js";
import { assistantCopy as englishCopy } from "../../web/lib/i18n/en/assistants.js";
import { assistantChannelCopy as germanChannel } from "../../web/lib/i18n/de/assistant-channel.js";
import { assistantChannelCopy as englishChannel } from "../../web/lib/i18n/en/assistant-channel.js";
import { assistantTeamCopy as germanTeam } from "../../web/lib/i18n/de/assistant-team.js";
import { assistantTeamCopy as englishTeam } from "../../web/lib/i18n/en/assistant-team.js";

// The agent catalog is split so the settings redesign has room for new keys.
test("agent channel and team copy live in their own catalogs", (t) => {
  t.after(() => setLanguage("de", { persist: false }));
  for (const language of ["de", "en"]) {
    setLanguage(language, { persist: false });
    assert.equal(assistantCopy.channel.language, assistantChannelCopy.language, language);
    assert.equal(
      assistantCopy.team.modelChanged,
      assistantTeamCopy.modelChanged,
      language,
    );
  }
});

test("the moved blocks are the split catalogs and left the main catalog", () => {
  for (const [main, channel, team] of [
    [germanCopy, germanChannel, germanTeam],
    [englishCopy, englishChannel, englishTeam],
  ]) {
    assert.equal(main.channel, channel);
    assert.equal(main.team, team);
  }
});
