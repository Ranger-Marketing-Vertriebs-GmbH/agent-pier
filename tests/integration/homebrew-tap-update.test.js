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

test("tap retries return the merged version PR without pushing another branch", async () => {
  const { updateHomebrewTap } = await import("../../scripts/homebrew-tap-update.mjs");
  const run = async (command, args) => {
    if (command === "git" && args[0] === "status") return { stdout: "" };
    if (command === "gh" && args[0] === "pr" && args[1] === "list")
      return {
        stdout: args.includes("all")
          ? JSON.stringify([{ state: "MERGED", url: "https://example.invalid/pr/1" }])
          : "[]",
      };
    throw Error("A merged version must not mutate the tap again.");
  };
  const result = await updateHomebrewTap({
    tapDirectory: "/unused",
    metadata: {
      version: "1.2.3",
      bundle: { file: "agentpier-installer-1.2.3.tar.gz", sha256: "a".repeat(64) },
    },
    run,
  });
  assert.deepEqual(result, { proposed: false, url: "https://example.invalid/pr/1" });
});

for (const version of ["1.0.0", "2.0.0", "3.0.0-beta.1"]) {
  test(`stable tap retains version 2.0.0 for candidate ${version}`, async (t) => {
    const { updateHomebrewTap } = await import("../../scripts/homebrew-tap-update.mjs");
    const { renderInstallerFormula } = await import("../../scripts/homebrew-formula.mjs");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-tap-order-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    git(["config", "user.name", "Fixture"]);
    await fs.mkdir(path.join(root, "Formula"));
    const file = path.join(root, "Formula/agentpier-installer.rb");
    const formula = renderInstallerFormula({
      version: "2.0.0",
      file: "agentpier-installer-2.0.0.tar.gz",
      sha256: "a".repeat(64),
    });
    await fs.writeFile(file, formula);
    git(["add", "."]);
    git(["commit", "-qm", "fixture"]);
    const head = git(["rev-parse", "HEAD"]);
    const writes = [];
    const result = await updateHomebrewTap({
      tapDirectory: root,
      metadata: {
        version,
        bundle: { file: `agentpier-installer-${version}.tar.gz`, sha256: "b".repeat(64) },
      },
      run: async (command, args) => {
        if (command === "git" && args[0] === "ls-remote") return { stdout: "" };
        if (command === "git" && args[0] !== "push") return { stdout: git(args) };
        if (command === "gh" && args[1] === "list") return { stdout: "[]" };
        writes.push([command, args]);
        return { stdout: "" };
      },
    });
    assert.equal(result.proposed, false);
    assert.equal(await fs.readFile(file, "utf8"), formula);
    assert.equal(git(["rev-parse", "HEAD"]), head);
    assert.deepEqual(writes, []);
  });
}
