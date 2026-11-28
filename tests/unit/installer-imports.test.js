import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// `sh scripts/install.sh` runs in a clean checkout, before `npm ci`: the installer
// scripts and everything they import statically may load Node's own modules and the
// repository's files only. A provisioning step that pulls in a server module with an
// npm dependency would break every first installation.
const root = path.resolve(import.meta.dirname, "../..");
const statement =
  /(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g;

function graph(entry) {
  const files = new Set();
  const foreign = [];
  const walk = (file) => {
    if (files.has(file)) return;
    files.add(file);
    for (const match of fs.readFileSync(file, "utf8").matchAll(statement)) {
      const specifier = match[1] || match[2];
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith(".")) walk(path.resolve(path.dirname(file), specifier));
      else foreign.push(`${path.relative(root, file)} imports ${specifier}`);
    }
  };
  walk(path.join(root, entry));
  return { files, foreign };
}

test("the installer scripts import nothing from node_modules", () => {
  for (const entry of [
    "scripts/release-install.mjs",
    "scripts/setup-options.mjs",
    "scripts/install-dependencies.mjs",
  ]) {
    const { files, foreign } = graph(entry);
    assert.deepEqual(foreign, [], entry);
    assert.ok(files.size >= 1);
  }
  // The walk does find a foreign import where there is one.
  assert.notDeepEqual(graph("server/app.js").foreign, []);
  // The installer loads the Android device step with it.
  assert.ok(
    graph("scripts/release-install.mjs").files.has(
      path.join(root, "server/features/devices/device-provisioning.js"),
    ),
  );
});
