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

// Remaining mentions of a CLI's config variables or home folders, one reason each.
// Files may only be removed from this list.
const ROOT_ALLOWED = {
  "server/features/tools/rea-environment.js":
    "REA scrubs and re-pins the whole environment; it is not a config-root lookup",
  "server/features/chat/slash-discovery-claude.js":
    "project-level .claude folder under the session cwd, not the account root",
  "server/features/assistants/project-paths.js":
    "project-relative folder names, not the account root",
  "server/features/assistants/project-config-lock.js": "project-relative .claude folder",
  "server/features/assistants/chromium-launch.js": "Chromium's own XDG_CONFIG_HOME",
  "server/features/assistants/runtimes/hermes/hermes-environment.js":
    "Hermes agent environment, not a coding CLI",
  "server/features/assistants/runtimes/hermes/hermes-install.js":
    "Hermes installer scratch environment",
  "server/features/repositories/repository-store.js": "git scratch environment",
  "server/features/operations/releases.js":
    "scrubbed environment names for release builds",
  "server/features/pipelines/artifact-reader.js": "ignored file names in pipelines",
  "server/features/providers/provider-launch.js":
    "writes into the profile env that profileEnv() just produced",
  "server/features/providers/endpoint-launch.js":
    "writes into the profile env that profileEnv() just produced",
  "server/features/accounts/account-store.js":
    "writes into the profile env that profileEnv() just produced",
  "server/features/requests/request-launch.js":
    "needs to know whether the Claude override is set (trust file)",
  "server/features/requests/request-broker.js": "bridge plugin folder names",
  "server/features/extensions/extension-store.js":
    ".claude.json sits in the override folder only when the override is set",
  "server/features/cli-profiles/configuration.js":
    ".claude.json sits in the override folder only when the override is set",
  "server/features/tools/native-installer.js": "nono install dir, not a coding CLI",
  "server/features/claude-mod/claude-mod-launch.js": "mod bridge folder names",
  "server/features/memory/memory-integration.js": "plugin manifest folder name",
  "server/features/assistants/assistant-provider-endpoint.js": ".local host suffix",
  "server/lib/i18n/de/scripts.js": "message text",
};

test("no config-root fallbacks outside the CLI drivers", () => {
  const pattern =
    /\b(CLAUDE_CONFIG_DIR|CODEX_HOME|XDG_(CONFIG|DATA)_HOME)\b|"\.(claude|codex|config|local)"|["'`]\.claude\.json["'`]/;
  const found = [];
  for (const file of sourceFiles(path.join(ROOT, "server"))) {
    const rel = path.relative(ROOT, file);
    if (rel.startsWith("server/features/clis/") || rel in ROOT_ALLOWED) continue;
    fs.readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (pattern.test(line)) found.push(`${rel}:${index + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(found, []);
});
