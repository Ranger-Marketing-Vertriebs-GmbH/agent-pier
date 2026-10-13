import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import YAML from "yaml";
import {
  assistantRuntimePaths,
  assistantRuntimeRelevant,
  changedFiles,
  decide,
  globPattern,
} from "../../scripts/assistant-runtime-paths.mjs";

const base = "a".repeat(40);

test("globs follow GitHub path filter semantics", () => {
  assert.ok(
    globPattern("server/features/assistants/**").test(
      "server/features/assistants/a/b.js",
    ),
  );
  assert.ok(
    globPattern("scripts/*assistant*.mjs").test("scripts/verify-assistant-runtime.mjs"),
  );
  assert.equal(
    globPattern("scripts/*assistant*.mjs").test("scripts/x/assistant.mjs"),
    false,
  );
  assert.ok(
    globPattern("tests/**/assistant*").test("tests/integration/assistant-x.test.js"),
  );
  assert.ok(globPattern("tests/helpers/mcp-*").test("tests/helpers/mcp-servers.js"));
  assert.equal(globPattern("package.json").test("web/package.json"), false);
  assert.equal(globPattern("server/lib/storage.js").test("server/lib/storageXjs"), false);
});

test("assistant runtime changes are relevant, unrelated changes are not", () => {
  assert.ok(assistantRuntimeRelevant(["README.md", "server/features/assistants/x.js"]));
  assert.ok(assistantRuntimeRelevant(["package-lock.json"]));
  assert.ok(assistantRuntimeRelevant(["server/http/routes/mcp-servers.js"]));
  assert.equal(
    assistantRuntimeRelevant(["web/features/chat/Chat.jsx", "docs/x.md"]),
    false,
  );
  assert.equal(assistantRuntimeRelevant([]), false);
});

test("the queue paths cover every Assistant runtime workflow filter", () => {
  const workflow = YAML.parse(
    fs.readFileSync(
      new URL("../../.github/workflows/assistant-runtime.yml", import.meta.url),
      "utf8",
    ),
  );
  for (const event of ["push", "pull_request"])
    for (const filter of workflow.on[event].paths)
      assert.ok(assistantRuntimePaths.includes(filter), `${event} path ${filter}`);
});

test("changed files come from a diff against the fetched base", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    return args[0] === "diff" ? "a.js\nweb/b.jsx\n" : "";
  };
  assert.deepEqual(changedFiles(base, run), ["a.js", "web/b.jsx"]);
  assert.deepEqual(calls, [
    ["git", "fetch", "--no-tags", "--depth=1", "origin", base],
    ["git", "diff", "--name-only", base, "HEAD"],
  ]);
});

test("an unreadable diff or a missing base runs the contracts", () => {
  const failing = () => {
    throw new Error("fetch failed");
  };
  assert.equal(changedFiles(base, failing), null);
  assert.equal(changedFiles("", failing), null);
  assert.equal(changedFiles("HEAD~1", failing), null);
  assert.equal(decide(base, failing).relevant, true);
  assert.equal(decide(undefined, failing).relevant, true);
});

test("an unrelated diff skips the contracts and says why", () => {
  const run = (command, args) => (args[0] === "diff" ? "web/a.jsx\ndocs/b.md\n" : "");
  assert.deepEqual(decide(base, run), {
    relevant: false,
    reason: "none of 2 changed file(s) touches the assistant runtime",
  });
  const relevant = (command, args) =>
    args[0] === "diff" ? "server/features/assistants/a.js\n" : "";
  assert.equal(decide(base, relevant).relevant, true);
});
