import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * OpenCode loads AgentPier's plugins in its own runtime, Bun. Bun finds a package
 * named by a bare specifier only when it may list every folder above the importing
 * file up to the one that holds `node_modules`. A sandboxed session reads `server/`,
 * `vendor/` and `node_modules/` but may not list the installation root between them
 * (docs/sandbox.md), so a plugin whose imports reach a package does not load there:
 * "Cannot find package 'smol-toml' imported from …/clis/codex/binding.js". Node,
 * which the hooks of the other CLIs run in, asks for the package folder directly and
 * is not affected.
 *
 * So everything these modules import, directly or not, is a relative file or a
 * `node:` builtin. tests/matrix/nono-opencode-needs.test.js loads them in a real
 * sandbox when OpenCode or Bun is installed.
 */
const root = fileURLToPath(new URL("../..", import.meta.url));
const OPENCODE_PLUGINS = [
  "server/native-session-opencode.js",
  "server/features/sessions/native-session-opencode.js",
  "server/features/requests/opencode-plugin.js",
  "server/features/agentbus/agentbus-opencode.js",
  "server/features/memory/memory-opencode.js",
  "server/features/ssh/ssh-opencode.js",
];

const specifiers =
  /(?:import|export)\s[^;'"]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

/** Every package a module reaches by a bare name, with the file that names it. */
function barePackages(entry) {
  const seen = new Set();
  const bare = [];
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const match of fs.readFileSync(file, "utf8").matchAll(specifiers)) {
      const specifier = match[1] || match[2] || match[3];
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith(".")) walk(path.resolve(path.dirname(file), specifier));
      else bare.push(`${specifier} (${path.relative(root, file)})`);
    }
  };
  walk(path.join(root, entry));
  return { bare, modules: seen.size };
}

test("the walk finds a package behind relative imports", () => {
  // The server side of the binding reaches the CLI drivers and their parsers.
  const { bare } = barePackages("server/features/sessions/native-session-binding.js");
  assert.ok(bare.some((entry) => entry.startsWith("smol-toml ")));
});

for (const plugin of OPENCODE_PLUGINS)
  test(`${plugin} imports no package by a bare name`, () => {
    const { bare, modules } = barePackages(plugin);
    assert.ok(modules > 0);
    assert.deepEqual(bare, []);
  });

test("every OpenCode plugin module of the server is checked", () => {
  // The modules a launch names to OpenCode: `*-opencode.js` and the request plugin.
  const found = [];
  const scan = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (/-opencode\.js$|^opencode-plugin\.js$/.test(entry.name))
        found.push(path.relative(root, file));
    }
  };
  scan(path.join(root, "server"));
  assert.deepEqual(found.sort(), [...OPENCODE_PLUGINS].sort());
});
