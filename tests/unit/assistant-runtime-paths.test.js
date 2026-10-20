import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import {
  assistantRuntimePaths,
  assistantRuntimeRelevant,
  changedFiles,
  decide,
  globPattern,
} from "../../scripts/assistant-runtime-paths.mjs";

const base = "a".repeat(40);
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

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
  // `**/` also matches no directory at all, as in GitHub's filters.
  assert.ok(globPattern("tests/**/assistant*").test("tests/assistant-x.test.js"));
  assert.equal(globPattern("tests/**/assistant*").test("tests/x/y/other.js"), false);
  assert.equal(globPattern("tests/**/assistant*").test("testsassistant.js"), false);
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
  // Pull requests only: after a merge the contracts run nightly, not on push.
  assert.equal(workflow.on.push, undefined);
  for (const filter of workflow.on.pull_request.paths)
    assert.ok(assistantRuntimePaths.includes(filter), `pull_request path ${filter}`);
});

// A fake git: `present` decides whether the base commit exists locally,
// `shallow` what rev-parse reports, `diff` the diff output.
function git({ present = false, shallow = false, diff = "" } = {}) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "cat-file" && !present) throw new Error("missing");
    if (args[0] === "rev-parse") return shallow ? "true\n" : "false\n";
    return args[0] === "diff" ? diff : "";
  };
  return { run, calls };
}

test("a missing base is fetched shallowly only in a shallow clone", () => {
  const ci = git({ shallow: true, diff: "a.js\nweb/b.jsx\n" });
  assert.deepEqual(changedFiles(base, ci.run), ["a.js", "web/b.jsx"]);
  assert.deepEqual(ci.calls, [
    ["git", "cat-file", "-e", `${base}^{commit}`],
    ["git", "rev-parse", "--is-shallow-repository"],
    ["git", "fetch", "--no-tags", "--depth=1", "origin", base],
    ["git", "diff", "--no-renames", "--name-only", base, "HEAD"],
  ]);
  const full = git();
  changedFiles(base, full.run);
  assert.deepEqual(full.calls[2], ["git", "fetch", "--no-tags", "origin", base]);
  const local = git({ present: true });
  changedFiles(base, local.run);
  assert.deepEqual(
    local.calls.map((call) => call[1]),
    ["cat-file", "diff"],
  );
});

test("moving a file out of an assistant path still runs the contracts", (t) => {
  // Real git: with rename detection the diff would list only lib/x.js.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-paths-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sh = (...args) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8", env: gitEnv });
  sh("init", "-q");
  fs.mkdirSync(path.join(directory, "server/features/assistants"), { recursive: true });
  fs.writeFileSync(
    path.join(directory, "server/features/assistants/x.js"),
    "export const x = 1;\n".repeat(20),
  );
  sh("add", ".");
  sh("commit", "-qm", "base");
  const baseSha = sh("rev-parse", "HEAD").trim();
  fs.mkdirSync(path.join(directory, "lib"));
  sh("mv", "server/features/assistants/x.js", "lib/x.js");
  sh("commit", "-qm", "move");
  assert.deepEqual(sh("diff", "--name-only", baseSha, "HEAD").trim().split("\n"), [
    "lib/x.js",
  ]);
  const run = (command, args, options) =>
    execFileSync(command, args, { ...options, cwd: directory, env: gitEnv });
  const files = changedFiles(baseSha, run);
  assert.deepEqual(files.sort(), ["lib/x.js", "server/features/assistants/x.js"]);
  assert.equal(decide(baseSha, run).relevant, true);
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
