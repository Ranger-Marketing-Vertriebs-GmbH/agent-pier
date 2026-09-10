import test from "node:test";
import assert from "node:assert/strict";
import { ensureDependencies, runInstaller } from "../../scripts/release-install.mjs";

function fixture({ unavailable = ["tmux"], noManager = false, broken = false } = {}) {
  const missing = new Set(unavailable),
    calls = [];
  return {
    calls,
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      if (missing.has(command) || (noManager && ["brew", "apt-get"].includes(command)))
        throw Object.assign(Error("missing"), { code: "ENOENT" });
      if (args.includes("install") && !broken) missing.clear();
      return { stdout: "fixture" };
    },
  };
}

test("repair mode installs both prerequisites without a release or data directory", async () => {
  const ctx = fixture({ unavailable: ["tmux", "git"] });
  const result = await runInstaller(["--dependencies-only"], {
    run: ctx.run,
    platform: "darwin",
    env: { PATH: "/custom/bin" },
  });
  assert.deepEqual(result, { installedDependencies: ["tmux", "git"] });
  assert.deepEqual(ctx.calls.find((c) => c.args.includes("install")).args, [
    "install",
    "tmux",
    "git",
  ]);
  assert.ok(ctx.calls.every((c) => c.options.env.PATH.includes("/opt/homebrew/bin")));
});

test("available prerequisites require no package manager and do not leak environment in repair output", async () => {
  const ctx = fixture({ unavailable: [] });
  const result = await runInstaller(["--dependencies-only"], {
    run: ctx.run,
    env: { SECRET: "hidden" },
  });
  assert.deepEqual(
    ctx.calls.map((c) => c.command),
    ["tmux", "git"],
  );
  assert.deepEqual(result, { installedDependencies: [] });
});

for (const [uid, interactive, command, prefix] of [
  [0, false, "apt-get", []],
  [501, true, "sudo", ["apt-get"]],
  [501, false, "sudo", ["-n", "apt-get"]],
])
  test(`Linux dependency installation uid=${uid} interactive=${interactive}`, async () => {
    const ctx = fixture();
    await ensureDependencies({ run: ctx.run, platform: "linux", uid, interactive });
    assert.ok(
      ctx.calls.some(
        (c) =>
          c.command === command &&
          JSON.stringify(c.args) === JSON.stringify([...prefix, "install", "-y", "tmux"]),
      ),
    );
  });

for (const platform of ["darwin", "linux"])
  test(`${platform} reports how to proceed when its package manager is absent`, async () => {
    const ctx = fixture({ noManager: true });
    await assert.rejects(
      ensureDependencies({ run: ctx.run, platform }),
      platform === "darwin" ? /Homebrew/ : /package manager/,
    );
    assert.ok(ctx.calls.every((c) => !c.args.includes("install")));
  });

test("a successful package manager exit does not hide a still-missing tmux", async () => {
  const ctx = fixture({ broken: true });
  await assert.rejects(
    ensureDependencies({ run: ctx.run, platform: "darwin" }),
    /tmux is still unavailable/,
  );
});

test("invalid and conflicting CLI options fail before any host changes", async () => {
  for (const args of [
    ["--unknown"],
    ["--skip-dependencies", "--install-dependencies"],
    ["--dependencies-only", "--skip-dependencies"],
    ["--dependencies-only", "--service"],
    ["--dependencies-only", "--data-dir", "/data"],
  ]) {
    const ctx = fixture();
    await assert.rejects(runInstaller(args, { run: ctx.run }));
    assert.equal(ctx.calls.length, 0);
  }
});
