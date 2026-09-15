import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

test("generated Homebrew formula installs a working wrapper without running setup", async (t) => {
  const { renderInstallerFormula } = await import("../../scripts/homebrew-formula.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-formula-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "scripts"));
  await fs.writeFile(
    path.join(root, "scripts/setup.sh"),
    'case "$1" in --version) command -v brew > "$FORMULA_BREW_LOG"; echo 1.2.3;; --help) echo "AgentPier installer";; *) echo "setup executed"; exit 9;; esac\n',
  );
  const file = path.join(root, "formula.rb");
  await fs.writeFile(
    file,
    renderInstallerFormula({
      version: "1.2.3",
      file: "agentpier-installer-1.2.3.tar.gz",
      sha256: "a".repeat(64),
    }),
  );
  const prefix = path.join(root, "brew prefix with spaces");
  await fs.mkdir(path.join(prefix, "bin"), { recursive: true });
  await fs.writeFile(path.join(prefix, "bin/brew"), "#!/bin/sh\necho fixture\n", {
    mode: 0o755,
  });
  const brewLog = path.join(root, "brew-log");
  const harness = path.resolve("tests/fixtures/homebrew-formula-harness.rb");
  const output = JSON.parse(
    execFileSync("ruby", [harness, file], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "/usr/bin:/bin",
        FORMULA_PREFIX: prefix,
        FORMULA_BREW_LOG: brewLog,
      },
    }),
  );
  assert.equal(output.version, "1.2.3");
  assert.equal(output.sha256, "a".repeat(64));
  assert.equal(
    output.url,
    "https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases/download/v1.2.3/agentpier-installer-1.2.3.tar.gz",
  );
  assert.ok(output.dependencies.includes("git"));
  assert.ok(output.dependencies.includes("tmux"));
  assert.equal(output.installedVersion.trim(), "1.2.3");
  assert.equal(
    (await fs.readFile(brewLog, "utf8")).trim(),
    path.join(prefix, "bin/brew"),
  );
});

test("formula generation rejects values that could escape Ruby or change release identity", async () => {
  const { renderInstallerFormula } = await import("../../scripts/homebrew-formula.mjs");
  for (const input of [
    {
      version: '1.2.3"; system("bad")',
      file: "agentpier-installer-1.2.3.tar.gz",
      sha256: "a".repeat(64),
    },
    { version: "1.2.3", file: "../other.tar.gz", sha256: "a".repeat(64) },
    { version: "1.2.3", file: "agentpier-installer-1.2.3.tar.gz", sha256: "bad" },
  ])
    assert.throws(() => renderInstallerFormula(input));
});
