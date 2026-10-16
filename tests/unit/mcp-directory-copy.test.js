import test from "node:test";
import assert from "node:assert/strict";
import * as de from "../../web/lib/i18n/de/mcp-directory.js";
import * as en from "../../web/lib/i18n/en/mcp-directory.js";

// The directory screens, the update pill and the edit hints read these keys.
const screenKeys = [
  "sourceCard",
  "sourceCardHint",
  "turnedOff",
  "openSettings",
  "unreachable",
  "title",
  "helper",
  "searchLabel",
  "searchButton",
  "emptyHint",
  "loading",
  "results",
  "hiddenByFilter",
  "showAll",
  "detailLoading",
  "noHit",
  "noHitPackage",
  "noHitPaste",
  "failed",
  "tryAgain",
  "showMore",
  "filters",
  "installable",
  "all",
  "verified",
  "verifiedHint",
  "deprecated",
  "version",
  "options",
  "reasons",
  "detailClose",
  "published",
  "status",
  "sourceLink",
  "website",
  "linkNote",
  "howItRuns",
  "settingsNeeded",
  "noSettingsMarked",
  "required",
  "secret",
  "reviewNote",
  "use",
  "listedAs",
  "useHints",
  "urlVariable",
  "addressPreview",
  "updateAvailable",
  "listedVersion",
  "identifierHint",
  "remoteHint",
];

function strings(value, found = []) {
  if (typeof value === "function") {
    found.push(value(...Array.from({ length: value.length }, () => "x")));
  } else if (typeof value === "string") found.push(value);
  else if (value && typeof value === "object")
    for (const child of Object.values(value)) strings(child, found);
  return found;
}

test("directory copy has every screen key in both languages", () => {
  for (const [language, copy] of [
    ["de", de.mcpDirectoryCopy],
    ["en", en.mcpDirectoryCopy],
  ]) {
    for (const key of screenKeys) assert.ok(key in copy, `${language}.${key}`);
    assert.equal(copy.options.unsupported("oci").includes("oci"), true, language);
    assert.equal(copy.urlVariable("tenant").includes("{tenant}"), true, language);
    assert.equal(copy.helper("registry.test").includes("registry.test"), true, language);
  }
});

test("directory copy never claims AgentPier reviewed a server", () => {
  const english = strings(en.mcpDirectoryCopy).join("\n");
  const german = strings(de.mcpDirectoryCopy).join("\n");
  assert.doesNotMatch(english, /reviewed by AgentPier|AgentPier (has )?reviewed/i);
  assert.doesNotMatch(german, /von AgentPier geprüft|AgentPier hat .*geprüft/i);
  assert.match(english, /A directory listing is not a security review\./);
  assert.match(english, /Check who published the package before you install it\./);
});
