import test from "node:test";
import assert from "node:assert/strict";
import { ensureDependencies, runInstaller } from "../../scripts/release-install.mjs";
import { detectUtilities } from "../../server/features/accounts/account-store.js";

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
      return { stdout: "fixture", stderr: "OpenSSH_9.6p1" };
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
    ["tmux", "git", "ssh"],
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

test("macOS bootstraps Homebrew before installing missing tmux and Git", async () => {
  let brew = false,
    installed = false;
  const calls = [];
  await ensureDependencies({
    platform: "darwin",
    run: async (command, args) => {
      calls.push([command, args]);
      if (["tmux", "git"].includes(command) && !installed) throw Error("missing");
      if (command === "brew" && !brew) throw Error("missing");
      if (command === "/bin/sh") {
        assert.match(args[0], /install-homebrew\.sh$/);
        brew = true;
      }
      if (command === "brew" && args[0] === "install") installed = true;
      return { stdout: "", stderr: "OpenSSH_9.9p2, LibreSSL 3.3.6" };
    },
  });
  assert.ok(installed);
  assert.equal(calls.filter(([command]) => command === "/bin/sh").length, 1);
});

test("check-only does not bootstrap Homebrew", async () => {
  const ctx = fixture({ noManager: true });
  await assert.rejects(
    ensureDependencies({ platform: "darwin", run: ctx.run, install: false }),
    /Missing tmux/,
  );
  assert.ok(ctx.calls.every((c) => ["tmux", "git", "ssh"].includes(c.command)));
});

for (const [stderr, found] of [
  ["OpenSSH_8.2p1 Ubuntu-4ubuntu0.11, OpenSSL 1.1.1f  31 Mar 2020", /OpenSSH 8\.2/],
  ["OpenSSH_7.4p1, OpenSSL 1.0.2k-fips", /OpenSSH 7\.4/],
  ["Sun_SSH_2.4, SSH protocols 1.5/2.0", /does not report an OpenSSH version/],
])
  test(`installation refuses ${stderr.split(",")[0]} before installing anything`, async () => {
    for (const install of [true, false]) {
      const calls = [];
      const run = async (command, args) => {
        calls.push([command, args]);
        if (command === "tmux") throw Error("missing");
        return command === "ssh" ? { stdout: "", stderr } : { stdout: "fixture" };
      };
      await assert.rejects(ensureDependencies({ run, platform: "linux", install }), {
        message: new RegExp(`OpenSSH 8\\.9 or newer[^]*${found.source}`),
      });
      assert.ok(calls.every(([, args]) => !args.includes("install")));
    }
  });

test("OpenSSH 8.9 and newer pass; a missing ssh is installed as the OpenSSH client", async () => {
  for (const version of ["OpenSSH_8.9p1", "OpenSSH_9.6p1", "OpenSSH_10.0p2"]) {
    const run = async () => ({ stdout: "", stderr: `${version}, OpenSSL 3` });
    assert.deepEqual(
      (await ensureDependencies({ run, platform: "linux" })).installed,
      [],
    );
  }
  for (const [platform, name] of [
    ["linux", "openssh-client"],
    ["darwin", "openssh"],
  ]) {
    const ctx = fixture({ unavailable: ["ssh"] });
    const result = await ensureDependencies({ run: ctx.run, platform, uid: 0 });
    assert.deepEqual(result.installed, ["ssh"]);
    const install = ctx.calls.find((c) => c.args.includes("install"));
    assert.equal(install.args.at(-1), name);
  }
  const ctx = fixture({ unavailable: ["ssh"] });
  await assert.rejects(
    ensureDependencies({ run: ctx.run, install: false }),
    /Missing ssh/,
  );
});

test("utility detection reports nono alongside gh", () => {
  const utilities = detectUtilities({ PATH: "" }, false, []);
  assert.deepEqual(
    utilities.map((entry) => entry.id),
    ["gh", "nono"],
  );
  for (const entry of utilities) {
    assert.equal(entry.utility, true);
    assert.equal(entry.installed, false);
    assert.equal(entry.path, null);
  }
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
