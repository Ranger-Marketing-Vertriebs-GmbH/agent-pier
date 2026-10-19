import test from "node:test";
import assert from "node:assert/strict";
import { curatedHintFor } from "../../web/features/mcp-servers/wizard/curated-hints.js";
import * as de from "../../web/lib/i18n/de/mcp-directory.js";
import * as en from "../../web/lib/i18n/en/mcp-directory.js";

test("REA's exact registry name or npm package carries its curated hint", () => {
  assert.equal(curatedHintFor({ serverName: "io.github.morluto/rea" }), "rea");
  assert.equal(curatedHintFor({ registry: "npm", packageName: "rea-agents" }), "rea");
  assert.equal(
    curatedHintFor({ registry: "npm", packageName: "  rea-agents  " }),
    "rea",
    "the package field may carry stray spaces",
  );
});

test("look-alike names never pick up a curated hint", () => {
  for (const serverName of [
    "io.github.morluto/rea-mcp",
    "io.github.morIuto/rea",
    "io.github.morluto/REA",
    "io.github.m0rluto/rea",
    "io.github.morluto/rea ",
    "com.example/io.github.morluto/rea",
    "constructor",
    "__proto__",
    "",
    undefined,
  ])
    assert.equal(curatedHintFor({ serverName }), null, String(serverName));
  for (const [registry, packageName] of [
    ["npm", "rea-agent"],
    ["npm", "rea-agents-cli"],
    ["npm", "@morluto/rea-agents"],
    ["npm", "REA-AGENTS"],
    ["pypi", "rea-agents"],
    ["npm", "toString"],
    [undefined, "rea-agents"],
  ])
    assert.equal(curatedHintFor({ registry, packageName }), null, packageName);
});

test("every curated hint has matching DE and EN copy", () => {
  const ids = Object.keys(en.mcpDirectoryCopy.curated.hints);
  assert.deepEqual(Object.keys(de.mcpDirectoryCopy.curated.hints), ids);
  assert.ok(ids.includes("rea"));
  for (const id of ids) {
    const [enHint, deHint] = [en, de].map((c) => c.mcpDirectoryCopy.curated.hints[id]);
    assert.equal(typeof enHint.title, "string");
    assert.equal(typeof deHint.title, "string");
    assert.equal(enHint.points.length, deHint.points.length, id);
  }
  assert.equal(typeof en.mcpDirectoryCopy.curated.label, "string");
  assert.equal(typeof de.mcpDirectoryCopy.curated.label, "string");
});
