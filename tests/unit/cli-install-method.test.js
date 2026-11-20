import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliInstallMethod } from "../../server/features/tools/cli-install-method.js";

function directory(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cli-method-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
/** An executable at `target` under `root`, reached through `link` when given. */
function install(root, target, link) {
  const file = path.join(root, target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
  if (!link) return file;
  const entry = path.join(root, link);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.symlinkSync(file, entry);
  return entry;
}

test("a Homebrew cask or formula names its own upgrade command", (t) => {
  const root = directory(t);
  const cask = install(
    root,
    "opt/homebrew/Caskroom/claude-code/2.1.300/claude",
    "opt/homebrew/bin/claude",
  );
  assert.deepEqual(cliInstallMethod(cask), {
    method: "homebrew",
    command: "brew upgrade --cask claude-code",
  });
  // A formula of a Node CLI keeps its packages inside the Cellar: still Homebrew.
  const formula = install(
    root,
    "usr/local/Cellar/opencode/1.19.0/libexec/lib/node_modules/opencode-ai/bin/opencode",
    "usr/local/bin/opencode",
  );
  assert.deepEqual(cliInstallMethod(formula), {
    method: "homebrew",
    command: "brew upgrade opencode",
  });
});

test("a global npm package names its install command, scoped or not", (t) => {
  const root = directory(t);
  const scoped = install(
    root,
    "opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js",
    "opt/homebrew/bin/codex",
  );
  assert.deepEqual(cliInstallMethod(scoped), {
    method: "npm",
    command: "npm install -g @openai/codex@latest",
  });
  const plain = install(root, "home/u/.npm-global/lib/node_modules/opencode-ai/bin/oc");
  assert.deepEqual(cliInstallMethod(plain), {
    method: "npm",
    command: "npm install -g opencode-ai@latest",
  });
});

test("anything else, or a name a shell would read differently, is unknown", (t) => {
  const root = directory(t);
  for (const target of [
    "home/u/.local/share/claude/versions/2.1.300",
    "opt/homebrew/Caskroom/bad;name/1/claude",
    "opt/homebrew/lib/node_modules/@scope/$(x)/cli.js",
    "opt/homebrew/lib/node_modules/.bin/claude",
  ])
    assert.deepEqual(cliInstallMethod(install(root, target)), { method: "unknown" });
  for (const missing of [path.join(root, "missing"), "", null, undefined, 42])
    assert.deepEqual(cliInstallMethod(missing), { method: "unknown" });
});
