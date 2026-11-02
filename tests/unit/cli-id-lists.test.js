import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const IDS = ["codex", "claude", "opencode"];

// Lists that mix ids for a reason no capability describes. Each entry is
// "<file>: <literal as written>" and may only shrink.
const ALLOWED = new Set([
  // Managed profile directories: codex and claude have their own, OpenCode uses
  // config/data/state/cache.
  'server/features/extensions/extension-store.js: ["codex", "claude", "config", "data", "state", "cache"]',
  'server/features/plugins/plugin-store.js: ["codex", "claude", "config", "data", "state", "cache"]',
  // Terminal-activity detection shares one prompt parser for Claude Code and Codex.
  'server/features/sessions/session-activity.js: ["claude", "codex"]',
  // Native limit warnings are parsed for Codex and Claude Code; the catalog's
  // rateLimits capability means something else (Claude Code has it off).
  'server/features/chat/native-limit-warnings.js: ["codex", "claude"]',
  // Catalog tool lists of models that Codex cannot serve.
  'server/features/providers/catalog-normalization.js: ["claude", "opencode"]',
]);

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

/** Array literals (no nested brackets) that contain two or more coding CLI ids. */
function offenders(dir, exclude) {
  const found = [];
  for (const file of sourceFiles(path.join(ROOT, dir))) {
    const rel = path.relative(ROOT, file);
    if (rel.startsWith(exclude)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/\[[^\][]*\]/g)) {
      const hits = IDS.filter((id) => new RegExp(`(["'\`])${id}\\1`).test(match[0]));
      if (hits.length < 2) continue;
      if (ALLOWED.has(`${rel}: ${match[0]}`)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      found.push(`${rel}:${line}`);
    }
  }
  return found;
}

test("no inline coding-CLI id arrays outside server/features/clis", () => {
  assert.deepEqual(offenders("server", "server/features/clis/"), []);
});
