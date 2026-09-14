import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

test("tap update commits only a validated formula on a version branch and proposes a PR", async (t) => {
  const { updateHomebrewTap } = await import("../../scripts/homebrew-tap-update.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-tap-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tap = path.join(root, "tap");
  await fs.mkdir(tap);
  execFileSync("git", ["init", "-q", "-b", "main", tap]);
  const git = (args) => execFileSync("git", ["-C", tap, ...args], { encoding: "utf8" });
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "user.name", "Fixture"]);
  git(["commit", "--allow-empty", "-m", "fixture"]);
  const metadata = {
    version: "1.2.3",
    bundle: { file: "agentpier-installer-1.2.3.tar.gz", sha256: "a".repeat(64) },
  };
  const calls = [];
  const run = async (command, args, options) => {
    if (command === "git" && args[0] === "ls-remote") return { stdout: "" };
    if (command === "git" && args[0] !== "push")
      return { stdout: execFileSync(command, args, { ...options, encoding: "utf8" }) };
    calls.push([command, args]);
    if (args[0] === "pr" && args[1] === "list") return { stdout: "[]" };
    return { stdout: "" };
  };
  await updateHomebrewTap({ tapDirectory: tap, metadata, run });
  assert.equal(
    git(["branch", "--show-current"]).trim(),
    "chore/agentpier-installer-1.2.3",
  );
  assert.equal(
    git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).trim(),
    "Formula/agentpier-installer.rb",
  );
  assert.ok(
    calls.some(
      ([cmd, args]) =>
        cmd === "git" &&
        args.join(" ") === "push origin HEAD:refs/heads/chore/agentpier-installer-1.2.3",
    ),
  );
  assert.ok(
    calls.some(
      ([cmd, args]) =>
        cmd === "gh" &&
        args[0] === "pr" &&
        args[1] === "create" &&
        args.includes("--body-file"),
    ),
  );
  await assert.rejects(
    updateHomebrewTap({
      tapDirectory: tap,
      metadata: { ...metadata, version: "bad;command" },
      run,
    }),
  );
});
