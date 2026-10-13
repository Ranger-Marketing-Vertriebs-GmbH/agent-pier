import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { selectAffected } from "../../scripts/affected/select.mjs";

// A tiny repository snapshot: path -> source text.
const repo = {
  "server/lib/util.js": "export const util = 1;\n",
  "server/features/alpha/alpha.js": 'import { util } from "../../lib/util.js";\n',
  "server/features/beta/beta.js": "export const beta = 2;\n",
  "server/features/cycle/one.js": 'import "./two.js";\nexport const one = 1;\n',
  "server/features/cycle/two.js": 'import { one } from "./one.js";\n',
  "server/features/lazy/lazy.js": "export const lazy = true;\n",
  "server/features/spawned/worker.js": "export const work = 1;\n",
  "server/index.js": 'import "./features/alpha/alpha.js";\n',
  "tests/fixtures/fake-cli.mjs":
    'import { work } from "../../server/features/spawned/worker.js";\n',
  "tests/fixtures/payload.json": "{}\n",
  "tests/unit/alpha.test.js": 'import "../../server/features/alpha/alpha.js";\n',
  "tests/unit/beta.test.js":
    'import { beta } from "../../server/features/beta/beta.js";\n',
  "tests/unit/cycle.test.js": 'import "../../server/features/cycle/one.js";\n',
  "tests/unit/lazy.test.js":
    'test("lazy", async () => { await import("../../server/features/lazy/lazy.js"); });\n',
  "tests/integration/spawn.test.js": [
    'import { spawn } from "node:child_process";',
    'spawn(process.execPath, [path.join(root, "tests/fixtures/fake-cli.mjs")]);',
    'const payload = new URL("../fixtures/payload.json", import.meta.url);',
    "",
  ].join("\n"),
  "tests/browser/alpha.spec.js": 'import { test } from "@playwright/test";\n',
  "tests/browser/screens.spec.js":
    'await page.screenshot({ path: "docs/screenshots/screens.png" });\n',
  "docs/testing.md": "# Testing\n",
  "docs/screenshots/screens.png": "png",
  "README.md": "# Readme\n",
};

const sourceOf = (files) => ({
  files: Object.keys(files),
  read: (file) => (file in files ? files[file] : null),
});
const select = (changed, files = repo, options = {}) =>
  selectAffected({ changed, source: sourceOf(files), ...options });
const allNode = Object.keys(repo).filter((file) => file.endsWith(".test.js"));

test("a change selects every test that imports it transitively, and only those", () => {
  const result = select(["server/lib/util.js"]);
  assert.equal(result.mode, "selected");
  assert.deepEqual(result.node, ["tests/unit/alpha.test.js"]);
});

test("a dynamic import of a string literal is an edge", () => {
  assert.deepEqual(select(["server/features/lazy/lazy.js"]).node, [
    "tests/unit/lazy.test.js",
  ]);
});

test("an import cycle is walked once and still reaches its tests", () => {
  assert.deepEqual(select(["server/features/cycle/two.js"]).node, [
    "tests/unit/cycle.test.js",
  ]);
});

test("a path a test names reaches it, also through what the named fixture imports", () => {
  for (const changed of [
    "tests/fixtures/fake-cli.mjs",
    "server/features/spawned/worker.js",
    "tests/fixtures/payload.json",
  ])
    assert.deepEqual(
      select([changed]).node,
      ["tests/integration/spawn.test.js"],
      changed,
    );
});

test("a changed test selects itself, and a deleted module still reaches its importers", () => {
  assert.deepEqual(select(["tests/unit/beta.test.js"]).node, ["tests/unit/beta.test.js"]);
  const { "server/features/beta/beta.js": _deleted, ...rest } = repo;
  const result = select(["server/features/beta/beta.js"], rest);
  assert.deepEqual(result.node, ["tests/unit/beta.test.js"]);
});

test("JSX modules are scanned for imports too", () => {
  const files = {
    ...repo,
    "web/features/alpha/Panel.jsx": [
      'import { Thing } from "./thing.js";',
      "export const Panel = () => <div className='x'>it's {Thing}</div>;",
      "",
    ].join("\n"),
    "web/features/alpha/thing.js": "export const Thing = 1;\n",
    "tests/unit/panel.test.js": 'import "../../web/features/alpha/Panel.jsx";\n',
  };
  assert.deepEqual(select(["web/features/alpha/thing.js"], files).node, [
    "tests/unit/panel.test.js",
  ]);
});

test("documentation alone selects nothing", () => {
  const result = select(["docs/testing.md", "README.md"]);
  assert.deepEqual(result, {
    mode: "none",
    node: [],
    browser: [],
    reasons: [],
    macos: false,
  });
});

test("a screenshot a spec writes is not inert: it selects that spec", () => {
  const result = select(["docs/screenshots/screens.png"]);
  assert.equal(result.mode, "selected");
  assert.deepEqual(result.browser, ["tests/browser/screens.spec.js"]);
});

for (const trigger of [
  "package.json",
  "package-lock.json",
  ".github/workflows/verify.yml",
  "scripts/test.mjs",
  "scripts/test-runner.mjs",
  "scripts/affected/select.mjs",
  "playwright.config.js",
  "vite.config.js",
  "tests/helpers/tmux-reaper.js",
])
  test(`a change to ${trigger} runs everything`, () => {
    const result = select([trigger, "docs/testing.md"]);
    assert.equal(result.mode, "all");
    assert.deepEqual(result.node.sort(), allNode.sort());
    assert.equal(result.browser.length, 2);
    assert.match(result.reasons[0], new RegExp(trigger.replaceAll(".", "\\.")));
  });

test("other workflows and repository metadata are inert", () => {
  for (const file of [
    ".github/workflows/nightly.yml",
    ".github/workflows/assistant-runtime.yml",
    ".github/dependabot.yml",
  ])
    assert.equal(select([file]).mode, "none", file);
});

test("a release bump of the package versions selects nothing", () => {
  const manifest = (version, extra = {}) =>
    JSON.stringify({ name: "agentpier", version, scripts: { test: "x" }, ...extra });
  const lock = (version) =>
    JSON.stringify({ version, packages: { "": { version, dependencies: { a: "1" } } } });
  const files = {
    ...repo,
    "package.json": manifest("1.2.4"),
    "package-lock.json": lock("1.2.4"),
  };
  const before = {
    "package.json": manifest("1.2.3"),
    "package-lock.json": lock("1.2.3"),
  };
  const bump = selectAffected({
    changed: ["package.json", "package-lock.json"],
    source: sourceOf(files),
    previous: (file) => before[file] ?? null,
  });
  assert.equal(bump.mode, "none");
  assert.deepEqual(bump.reasons, [
    "package.json changed only its version",
    "package-lock.json changed only its version",
  ]);
  const scripts = selectAffected({
    changed: ["package.json"],
    source: sourceOf({ ...files, "package.json": manifest("1.2.4", { private: true }) }),
    previous: (file) => before[file] ?? null,
  });
  assert.equal(scripts.mode, "all");
  // Without the base version the change counts in full.
  assert.equal(select(["package.json"], files).mode, "all");
});

test("platform code asks for a macOS run; other code does not", () => {
  const files = {
    ...repo,
    "server/features/beta/beta.js":
      'export const beta = process.platform === "darwin" ? 1 : 2;\n',
  };
  const platform = select(["server/features/beta/beta.js"], files);
  assert.equal(platform.macos, true);
  assert.match(platform.reasons.at(-1), /platform code: macOS run/);
  assert.equal(select(["server/lib/util.js"]).macos, false);
});

test("a changed file that does not parse runs everything", () => {
  const files = { ...repo, "server/features/beta/beta.js": "export const = ;\n" };
  const result = select(["server/features/beta/beta.js"], files);
  assert.equal(result.mode, "all");
  assert.match(result.reasons[0], /could not be parsed/);
});

test("a diff that could not be computed runs everything", () => {
  const result = select(null);
  assert.equal(result.mode, "all");
  assert.deepEqual(result.reasons, ["the changed files could not be computed"]);
});

test("a file no test imports or names runs everything, since it may be spawned", () => {
  const files = { ...repo, "scripts/install-runtime.mjs": "export {};\n" };
  const result = select(["scripts/install-runtime.mjs"], files);
  assert.equal(result.mode, "all");
  assert.match(result.reasons[0], /no test imports or names scripts\/install-runtime/);
});

test("a selection above the threshold share runs the whole suite", () => {
  const changed = ["server/lib/util.js", "server/features/beta/beta.js"];
  assert.equal(select(changed).node.length, 2);
  const result = select(changed, repo, { threshold: 0.3 });
  assert.deepEqual(result.node.sort(), allNode.sort());
  assert.match(result.reasons.at(-1), /2 of 5 node tests selected, above the 30%/);
});

test("the command line prints the selection as JSON and runs nothing for docs", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const run = (...args) =>
    spawnSync(process.execPath, ["scripts/affected-tests.mjs", ...args], {
      cwd: root,
      encoding: "utf8",
    });
  const docs = run("--files", "docs/never-named-by-a-test.md", "--json");
  assert.equal(docs.status, 0, docs.stderr);
  assert.deepEqual(JSON.parse(docs.stdout), {
    mode: "none",
    node: [],
    browser: [],
    reasons: [],
    macos: false,
  });
  const unknownBase = run("--base", "0".repeat(40), "--json");
  assert.equal(unknownBase.status, 0, unknownBase.stderr);
  const everything = JSON.parse(unknownBase.stdout);
  assert.equal(everything.mode, "all");
  assert.ok(everything.node.includes("tests/unit/affected-tests.test.js"));
  const nothing = run("--files", "docs/never-named-by-a-test.md", "--run");
  assert.equal(nothing.status, 0, nothing.stderr);
  assert.match(nothing.stdout, /No node tests are affected/);
  assert.notEqual(run("--files", "a.js", "--base", "HEAD").status, 0);
});
