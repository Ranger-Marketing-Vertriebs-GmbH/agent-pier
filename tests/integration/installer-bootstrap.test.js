import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const bootstrap = path.resolve("scripts/install-bootstrap.sh");
async function fixture(
  t,
  { present = [], manager = true, uid = "501", broken = false } = {},
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-bootstrap-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tool = async (name, body = "exit 0") => {
    const file = path.join(directory, name);
    await fs.writeFile(file, `#!/bin/sh\n${body}\n`);
    await fs.chmod(file, 0o755);
  };
  for (const name of present) await tool(name);
  await tool("id", `echo ${uid}`);
  await tool(
    "install-homebrew.sh",
    'command -v brew >/dev/null 2>&1 || { echo "Homebrew fixture unavailable" >&2; exit 1; }',
  );
  await tool(
    "sudo",
    'echo "sudo $*" >> "$FIXTURE_LOG"\n[ "$1" != -n ] || shift\nexec "$@"',
  );
  if (manager)
    for (const name of ["apt-get", "brew"])
      await tool(
        name,
        `echo "$0 $*" >> "$FIXTURE_LOG"
if [ "$1" = install ] && [ "${broken}" = false ]; then
  for name in curl tar sha256sum; do
    printf '#!/bin/sh\\nexit 0\\n' > "$PATH/$name"
    /bin/chmod 755 "$PATH/$name"
  done
fi`,
      );
  return {
    run: (platform, args = []) =>
      execute(
        "/bin/sh",
        ["-c", '. "$BOOTSTRAP_SCRIPT"; ensure_bootstrap_tools "$@"', "fixture", ...args],
        {
          env: {
            PATH: directory,
            PLATFORM: platform,
            BOOTSTRAP_SCRIPT: bootstrap,
            SCRIPT_DIR: directory,
            FIXTURE_LOG: path.join(directory, "calls"),
          },
        },
      ),
    calls: () => fs.readFile(path.join(directory, "calls"), "utf8").catch(() => ""),
  };
}

test("bootstrap uses existing download tools without invoking a package manager", async (t) => {
  const ctx = await fixture(t, { present: ["curl", "tar", "shasum"] });
  await ctx.run("darwin");
  assert.equal(await ctx.calls(), "");
});

for (const [platform, uid] of [
  ["darwin", "501"],
  ["linux", "501"],
  ["linux", "0"],
])
  test(`bootstrap installs and verifies missing tools on ${platform} uid=${uid}`, async (t) => {
    const ctx = await fixture(t, { uid });
    await ctx.run(platform);
    const calls = await ctx.calls();
    assert.match(calls, /install (?:-y )?curl tar coreutils/);
    if (platform === "linux" && uid !== "0") assert.match(calls, /sudo -n apt-get/);
    else assert.doesNotMatch(calls, /sudo/);
  });

test("bootstrap skip option reports missing tools without installation", async (t) => {
  const ctx = await fixture(t);
  await assert.rejects(
    ctx.run("linux", ["--skip-dependencies"]),
    /Missing Node bootstrap packages/,
  );
  assert.equal(await ctx.calls(), "");
});

test("bootstrap fails before download when a package manager is missing or did not provide tools", async (t) => {
  const absent = await fixture(t, { manager: false });
  await assert.rejects(absent.run("darwin"), /Homebrew/);
  await assert.rejects(absent.run("linux"), /package manager/);
  const broken = await fixture(t, { broken: true });
  await assert.rejects(broken.run("linux"), /still unavailable/);
});

test("the shell repair entrypoint runs from a checkout without node_modules", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-clean-install-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.cp("scripts", path.join(directory, "scripts"), { recursive: true });
  await fs.cp("server", path.join(directory, "server"), { recursive: true });
  await fs.writeFile(path.join(directory, "package.json"), '{"type":"module"}');
  const bin = path.join(directory, "bin");
  await fs.mkdir(bin);
  await fs.symlink(process.execPath, path.join(bin, "node"));
  for (const name of ["tmux", "git"]) {
    const file = path.join(bin, name);
    await fs.writeFile(file, '#!/bin/sh\necho "fixture version"\n');
    await fs.chmod(file, 0o755);
  }
  const result = await execute("/bin/sh", ["scripts/install.sh", "--dependencies-only"], {
    cwd: directory,
    env: { PATH: bin, HOME: directory },
  });
  assert.deepEqual(JSON.parse(result.stdout), { installedDependencies: [] });
  // Even a Node version probe must not run before invalid arguments are rejected.
  await fs.unlink(path.join(bin, "node"));
  await fs.writeFile(
    path.join(bin, "node"),
    '#!/bin/sh\necho "node invoked" >&2\nexit 1\n',
  );
  await fs.chmod(path.join(bin, "node"), 0o755);
  for (const args of [
    ["--unknown"],
    ["--dependencies-only", "--service"],
    ["--dependencies-only", "--skip-dependencies"],
    ["--install-root", "relative"],
  ]) {
    await assert.rejects(
      execute("/bin/sh", ["scripts/install.sh", ...args], {
        cwd: directory,
        env: { PATH: bin, HOME: directory },
      }),
      (error) => {
        assert.doesNotMatch(error.stderr, /node invoked|Installing Node/);
        assert.match(error.stderr, /option|paths are required/);
        return true;
      },
    );
  }
  assert.deepEqual((await fs.readdir(directory)).sort(), [
    "bin",
    "package.json",
    "scripts",
    "server",
  ]);
});
