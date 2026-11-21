import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import { restoreSettingsCopy } from "../../web/lib/i18n/messages/restore-settings.js";
import {
  hostBoundSettings,
  hostIndependentSettings,
} from "../../server/features/operations/config-backup.js";
import { hostFingerprint } from "../../server/features/operations/host-identity.js";

test("every config.json setting a restore reports has a label in both languages", (t) => {
  t.after(() => setLanguage("de"));
  for (const language of ["en", "de"]) {
    setLanguage(language);
    for (const key of ["port", ...hostIndependentSettings, ...hostBoundSettings])
      assert.equal(typeof restoreSettingsCopy.keys[key], "string", `${language}: ${key}`);
  }
  setLanguage("en");
  assert.equal(restoreSettingsCopy.keys.remoteUrl, "Tailscale address");
  assert.equal(restoreSettingsCopy.openRemoteAccess, "Open remote access settings");
});

test("the host fingerprint is stable and never the raw machine identifier", () => {
  const first = hostFingerprint();
  assert.equal(hostFingerprint(), first);
  if (first !== null) assert.match(first, /^[a-f0-9]{32}$/);
});
