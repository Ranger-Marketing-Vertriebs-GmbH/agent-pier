import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { browserSpecsFor, specsForFeature } from "../../scripts/affected/browser-map.mjs";
import { changedFiles } from "../../scripts/affected/repo-source.mjs";
import { selectAffected } from "../../scripts/affected/select.mjs";

const specs = [
  "tests/browser/agent-mcp-servers.spec.js",
  "tests/browser/agentbus.spec.js",
  "tests/browser/assistant-chat.spec.js",
  "tests/browser/assistants.spec.js",
  "tests/browser/chat-files.spec.js",
  "tests/browser/endpoint-routing.spec.js",
  "tests/browser/file-explorer.spec.js",
  "tests/browser/mcp-settings.spec.js",
  "tests/browser/provider-model-picker.spec.js",
  "tests/browser/shared-agency.spec.js",
];
const names = (selected) => selected.map((spec) => path.basename(spec, ".spec.js"));

test("an assistants feature change selects the assistant and agent specs", () => {
  const mapped = browserSpecsFor("web/features/assistants/settings/Tab.jsx", specs);
  assert.equal(mapped.feature, "assistants");
  assert.deepEqual(names(mapped.specs), [
    "agent-mcp-servers",
    "assistant-chat",
    "assistants",
  ]);
});

test("feature names match whole words, singulars and the explicit extra names", () => {
  assert.deepEqual(names(specsForFeature("files", specs)), [
    "chat-files",
    "file-explorer",
  ]);
  assert.deepEqual(names(specsForFeature("agentbus", specs)), ["agentbus"]);
  assert.deepEqual(names(specsForFeature("agency", specs)), ["shared-agency"]);
  assert.deepEqual(names(specsForFeature("providers", specs)), [
    "endpoint-routing",
    "provider-model-picker",
  ]);
  assert.deepEqual(names(specsForFeature("models", specs)), ["provider-model-picker"]);
  // A route without a spec of its own falls back to its first word.
  assert.deepEqual(names(specsForFeature("mcp-oauth", specs)), [
    "agent-mcp-servers",
    "mcp-settings",
  ]);
});

test("server features, routes and message catalogs map like web features", () => {
  for (const file of [
    "server/features/agentbus/broker.js",
    "server/http/routes/agentbus.js",
    "web/lib/i18n/de/agentbus.js",
    "web/lib/i18n/messages/agentbus.js",
    "server/lib/i18n/en/agentbus.js",
  ])
    assert.deepEqual(names(browserSpecsFor(file, specs).specs), ["agentbus"], file);
});

test("shared web and server code selects every spec; other paths name no feature", () => {
  for (const file of [
    "web/components/ListRow.jsx",
    "web/lib/api.js",
    "web/app/App.jsx",
    "web/styles/tokens.css",
    "web/main.jsx",
    "web/lib/i18n/de/common.js",
    "index.html",
    "public/sw.js",
    "server/app.js",
    "server/http/security.js",
    "server/lib/storage.js",
    "scripts/test-server.mjs",
  ])
    assert.deepEqual(browserSpecsFor(file, specs), { all: true }, file);
  assert.equal(browserSpecsFor("scripts/release-package.mjs", specs), null);
});

test("selection adds mapped specs, specs that import the change, and all for shared web", () => {
  const files = {
    "web/features/agentbus/Panel.jsx": "export const Panel = 1;\n",
    "web/features/agentbus/model.js": "export const model = 1;\n",
    "web/features/unmapped/View.jsx": "export const View = 1;\n",
    "web/components/Card.jsx": "export const Card = 1;\n",
    "tests/browser/agentbus.spec.js": "export {};\n",
    "tests/browser/chat.spec.js":
      'import { model } from "../../web/features/agentbus/model.js";\n',
    "tests/browser/login.spec.js": "export {};\n",
  };
  const source = { files: Object.keys(files), read: (file) => files[file] ?? null };
  const select = (changed) => selectAffected({ changed, source, threshold: 1 });
  assert.deepEqual(select(["web/features/agentbus/Panel.jsx"]).browser, [
    "tests/browser/agentbus.spec.js",
  ]);
  assert.deepEqual(select(["web/features/agentbus/model.js"]).browser, [
    "tests/browser/agentbus.spec.js",
    "tests/browser/chat.spec.js",
  ]);
  for (const shared of ["web/components/Card.jsx", "web/features/unmapped/View.jsx"]) {
    const result = select([shared]);
    assert.equal(result.browser.length, 3, shared);
    assert.equal(result.mode, "all", shared);
  }
});

test("a server catalog change selects readers of its namespace, not every importer", () => {
  const files = {
    "server/lib/i18n/de/alpha.js": "export const alphaCopy = { hi: 'Hallo' };\n",
    "server/lib/i18n/de/beta.js": "export const beta = { bye: 'Tschüss' };\n",
    "server/lib/i18n/catalog-de.js": [
      'import { alphaCopy } from "./de/alpha.js";',
      'import { beta } from "./de/beta.js";',
      "export const messages = { alpha: alphaCopy, beta };",
      "",
    ].join("\n"),
    "server/features/alpha/alpha.js":
      'import { messages } from "../../lib/i18n/catalog-de.js";\nmessages.alpha.hi;\n',
    "server/features/beta/beta.js":
      'import { messages } from "../../lib/i18n/catalog-de.js";\nmessages.beta.bye;\n',
    "tests/unit/alpha.test.js": 'import "../../server/features/alpha/alpha.js";\n',
    "tests/unit/beta.test.js": 'import "../../server/features/beta/beta.js";\n',
    "tests/unit/server-i18n-catalogs.test.js":
      'import { messages } from "../../server/lib/i18n/catalog-de.js";\n',
  };
  const source = { files: Object.keys(files), read: (file) => files[file] ?? null };
  const result = selectAffected({
    changed: ["server/lib/i18n/de/alpha.js"],
    source,
    threshold: 1,
  });
  assert.deepEqual(result.node, [
    "tests/unit/alpha.test.js",
    "tests/unit/server-i18n-catalogs.test.js",
  ]);
  // The merged catalog itself is ordinary code: its change reaches everyone.
  const hub = selectAffected({ changed: ["server/lib/i18n/catalog-de.js"], source });
  assert.equal(hub.mode, "all");
});

test("a web catalog or translation lock change selects the catalog-wide i18n tests", () => {
  const files = {
    "web/lib/i18n/de/alpha.js": "export const alphaCopy = { hi: 'Hallo' };\n",
    "web/lib/i18n/en/alpha.js": "export const alphaCopy = { hi: 'Hello' };\n",
    "web/lib/i18n/messages/alpha.js":
      'import "../de/alpha.js";\nimport "../en/alpha.js";\n',
    "web/lib/i18n/translation-lock.json": "{}\n",
    "server/lib/i18n/translation-lock.json": "{}\n",
    "tests/unit/alpha.test.js": 'import "../../web/lib/i18n/messages/alpha.js";\n',
    "tests/unit/other.test.js": "export {};\n",
    "tests/unit/plugin-messages.test.js": "export {};\n",
    "tests/unit/i18n-catalogs.test.js": "await readdir(base);\n",
    "tests/unit/i18n-translation-lock.test.js": "await loadCatalogs(kind);\n",
    "tests/unit/server-i18n-catalogs.test.js": "await readdir(base);\n",
    "tests/browser/alpha.spec.js": "export {};\n",
    "tests/browser/beta.spec.js": "export {};\n",
  };
  const source = { files: Object.keys(files), read: (file) => files[file] ?? null };
  const wide = [
    "tests/unit/i18n-catalogs.test.js",
    "tests/unit/i18n-translation-lock.test.js",
    "tests/unit/server-i18n-catalogs.test.js",
  ];
  const run = (changed) => selectAffected({ changed: [changed], source, threshold: 1 });
  assert.deepEqual(run("web/lib/i18n/de/alpha.js").node, [
    "tests/unit/alpha.test.js",
    ...wide,
  ]);
  assert.deepEqual(run("web/lib/i18n/en/alpha.js").node, [
    "tests/unit/alpha.test.js",
    ...wide,
  ]);
  for (const lock of [
    "web/lib/i18n/translation-lock.json",
    "server/lib/i18n/translation-lock.json",
  ]) {
    const result = run(lock);
    assert.deepEqual(result.node, wide, lock);
    assert.deepEqual(result.browser, [], lock);
    assert.equal(result.mode, "selected", lock);
  }
});

test("changed files come from the merge base, list renames as both paths, and never guess", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-affected-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args],
      {
        cwd: repo,
        encoding: "utf8",
      },
    ).trim();
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.js"), "export const a = 1;\n");
  fs.writeFileSync(path.join(repo, "b.js"), "export const b = 1;\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-qb", "topic");
  git("mv", "a.js", "renamed.js");
  git("commit", "-qm", "rename");
  git("checkout", "-q", "main");
  fs.writeFileSync(path.join(repo, "b.js"), "export const b = 2;\n");
  git("commit", "-qam", "main moves on");
  assert.deepEqual(changedFiles(repo, "main", "topic").sort(), ["a.js", "renamed.js"]);
  assert.deepEqual(changedFiles(repo, base, "topic").sort(), ["a.js", "renamed.js"]);
  assert.equal(changedFiles(repo, "0".repeat(40), "topic"), null);
  assert.equal(changedFiles(repo, "no-such-ref", "topic"), null);
});
