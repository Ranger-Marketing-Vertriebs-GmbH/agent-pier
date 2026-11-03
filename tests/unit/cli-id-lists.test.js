import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const IDS = ["codex", "claude", "opencode"];

// Lists that mix ids for a reason no capability describes. Each entry is
// "<file>: <literal as written>" and may only shrink; an entry that no longer
// matches fails the test below, so remove it in the change that removes the list.
const ALLOWED = new Set([
  // Managed profile directories: codex and claude have their own, OpenCode uses
  // config/data/state/cache.
  'server/features/extensions/extension-store.js: ["codex", "claude", "config", "data", "state", "cache"]',
  'server/features/plugins/plugin-store.js: ["codex", "claude", "config", "data", "state", "cache"]',
  // Catalog tool lists of models that Codex cannot serve.
  'server/features/providers/catalog-normalization.js: ["claude", "opencode"]',
  // The OpenClaw team plugin ships alone into OpenClaw and cannot import the catalog.
  'server/features/assistants/team-plugin/coding-session-tool.js: ["claude", "codex", "opencode"]',
]);

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.jsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Array literals (no nested brackets) that contain two or more coding CLI ids. */
function offenders(dir, exclude, used = new Set()) {
  const found = [];
  for (const file of sourceFiles(path.join(ROOT, dir))) {
    const rel = path.relative(ROOT, file);
    if (rel.startsWith(exclude)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/\[[^\][]*\]/g)) {
      const hits = IDS.filter((id) => new RegExp(`(["'\`])${id}\\1`).test(match[0]));
      if (hits.length < 2) continue;
      const key = `${rel}: ${match[0]}`;
      if (ALLOWED.has(key)) {
        used.add(key);
        continue;
      }
      const line = text.slice(0, match.index).split("\n").length;
      found.push(`${rel}:${line}`);
    }
  }
  return found;
}

const LIST_GUIDANCE =
  "Read the ids from the catalog (CODING_CLI_IDS or a capability) instead of an inline list.";

test("no inline coding-CLI id arrays outside server/features/clis", () => {
  assert.deepEqual(offenders("server", "server/features/clis/"), [], LIST_GUIDANCE);
});

test("no inline coding-CLI id arrays in the web app", () => {
  assert.deepEqual(offenders("web", "web/lib/i18n/"), [], LIST_GUIDANCE);
});

test("every allowed coding-CLI id array still exists", () => {
  const used = new Set();
  offenders("server", "server/features/clis/", used);
  offenders("web", "web/lib/i18n/", used);
  assert.deepEqual(
    [...ALLOWED].filter((entry) => !used.has(entry)),
    [],
    "remove allowlist entries that no longer match",
  );
});

// Remaining mentions of a CLI's config variables or home folders, one reason each.
// Files may only be removed from this list; a file that no longer mentions one
// fails the test, so remove its entry in the same change.
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
  "server/features/providers/endpoint-launch.js":
    "writes into the profile env that profileEnv() just produced",
  "server/features/requests/request-broker.js": "bridge plugin folder names",
  "server/features/tools/native-installer.js": "nono install dir, not a coding CLI",
  "server/features/assistants/assistant-provider-endpoint.js": ".local host suffix",
  "server/lib/i18n/de/scripts.js": "message text",
};

const ROOT_PATTERN =
  /\b(CLAUDE_CONFIG_DIR|CODEX_HOME|XDG_(CONFIG|DATA)_HOME)\b|"\.(claude|codex|config|local)"|["'`]\.claude\.json["'`]/;

function rootMentions(file) {
  const rel = path.relative(ROOT, file);
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line, index) =>
      /^\s*(\/\/|\*|\/\*)/.test(line) || !ROOT_PATTERN.test(line)
        ? []
        : [`${rel}:${index + 1}: ${line.trim()}`],
    );
}

test("no config-root fallbacks outside the CLI drivers", () => {
  const found = [];
  for (const file of sourceFiles(path.join(ROOT, "server"))) {
    const rel = path.relative(ROOT, file);
    if (rel.startsWith("server/features/clis/") || rel in ROOT_ALLOWED) continue;
    found.push(...rootMentions(file));
  }
  assert.deepEqual(found, []);
});

test("every file allowed to mention a config root still does", () => {
  const dead = Object.keys(ROOT_ALLOWED).filter((rel) => {
    const file = path.join(ROOT, rel);
    return !fs.existsSync(file) || rootMentions(file).length === 0;
  });
  assert.deepEqual(dead, [], "remove allowlist entries that no longer match");
});

// Branch budget: comparisons with a coding CLI id ("=== \"codex\"", "!== \"claude\"", …)
// outside the CLI drivers, counted per file. New per-CLI behaviour belongs in
// server/features/clis/, so the budget may only shrink. The counts are exact: a file
// over its count fails, and so does a file under it or one that no longer
// branches, so lower or remove its entry in the change that removed the branch.
const BRANCH_BUDGET = {
  "server/features/accounts/account-store.js": 1,
  "server/features/agentbus/agent-bus.js": 4,
  "server/features/agentbus/agentbus-broker.js": 4,
  "server/features/chat/chat-source-watch.js": 1,
  "server/features/chat/context-window.js": 1,
  "server/features/cli-profiles/configuration.js": 2,
  "server/features/mcp-servers/cli-oauth-status.js": 2,
  "server/features/mcp-servers/codex-mcp-logins.js": 2,
  "server/features/models/model-controller.js": 1,
  "server/features/pipelines/native-profile.js": 1,
  "server/features/plugins/codex-catalog.js": 4,
  "server/features/plugins/plugin-schema.js": 2,
  "server/features/plugins/plugin-store.js": 1,
  "server/features/requests/claude-folder-trust.js": 2,
  "server/features/requests/claude-runtime.js": 2,
  "server/features/requests/claude-startup-prompts.js": 1,
  "server/features/requests/codex-hook-trust.js": 1,
  "server/features/requests/request-approvals.js": 1,
  "server/features/requests/request-broker.js": 4,
  "server/features/secrets/session-secrets.js": 1,
  "server/features/sessions/native-session-binding.js": 8,
  "server/features/sessions/native-session-process.js": 3,
  "server/features/sessions/session-chat-input.js": 1,
  "server/features/sessions/session-slash-command.js": 1,
  "web/components/ProviderMark.jsx": 3,
  "web/features/chat/NativeDeliveryBadge.jsx": 1,
  "web/features/extensions/ExtensionWorkspace.jsx": 1,
  "web/features/plugins/CatalogAccount.jsx": 1,
  "web/features/providers/ProviderModelDetails.jsx": 1,
  "web/features/providers/ProviderModelPicker.jsx": 1,
  "web/features/requests/NativeRequest.jsx": 1,
};

const GUIDANCE =
  "Lower or remove the BRANCH_BUDGET entry, or move the branch into a CLI driver; never raise it.";

const BRANCH =
  /[!=]==\s*(["'`])(codex|claude|opencode)\1|(["'`])(codex|claude|opencode)\3\s*[!=]==/g;

test("tool-id equality branches outside server/features/clis only shrink", () => {
  const counts = {};
  for (const dir of ["server", "web"])
    for (const file of sourceFiles(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file);
      if (rel.startsWith("server/features/clis/")) continue;
      const count = [...fs.readFileSync(file, "utf8").matchAll(BRANCH)].length;
      if (count) counts[rel] = count;
    }
  assert.deepEqual(counts, BRANCH_BUDGET, GUIDANCE);
});
