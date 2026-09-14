import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-setup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scripts = path.join(root, "scripts");
  const bin = path.join(root, "bin");
  await fs.mkdir(scripts);
  await fs.mkdir(bin);
  for (const name of [
    "setup.sh",
    "setup-options.mjs",
    "install.sh",
    "install-bootstrap.sh",
  ])
    await fs.copyFile(path.resolve("scripts", name), path.join(scripts, name));
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(root, "installer-version"), "1.17.0\n");
  const calls = path.join(root, "calls");
  const tool = async (name, body) => {
    const file = path.join(bin, name);
    await fs.writeFile(
      file,
      `#!/bin/sh\nprintf '%s\\n' "${name} $* PATH=$PATH" >> "$FIXTURE_CALLS"\n${body}\n`,
    );
    await fs.chmod(file, 0o755);
  };
  await tool(
    "uname",
    `case "$1" in -s) echo Darwin;; -m) echo ${overrides.machine || "arm64"};; esac`,
  );
  await tool("sw_vers", `echo ${overrides.osVersion || "14.0"}`);
  await tool("id", `echo ${overrides.uid || "501"}`);
  await tool("sysctl", `echo ${overrides.translated || "0"}`);
  await tool(
    "node",
    `if [ "$(basename "$1")" = setup-options.mjs ]; then exec ${JSON.stringify(process.execPath)} "$@"; fi`,
  );
  for (const name of ["curl", "brew", "sudo", "launchctl"]) await tool(name, "exit 0");
  return {
    root,
    calls,
    run: (args = [], env = {}) =>
      execute("/bin/sh", [path.join(scripts, "setup.sh"), ...args], {
        env: {
          HOME: path.join(root, "home"),
          PATH: `${bin}:/usr/bin:/bin`,
          FIXTURE_CALLS: calls,
          ...env,
        },
      }),
    readCalls: () => fs.readFile(calls, "utf8").catch(() => ""),
  };
}

for (const [name, args, output] of [
  ["help", ["--help"], /Usage:/],
  ["version", ["--version"], /^1\.17\.0/m],
])
  test(`${name} is side-effect free without Node`, async (t) => {
    const ctx = await fixture(t);
    await fs.rm(path.join(ctx.root, "bin/node"));
    const result = await ctx.run(args);
    assert.match(result.stdout, output);
    assert.equal(await ctx.readCalls(), "");
  });

for (const args of [
  ["--unknown"],
  ["--data-dir"],
  ["--install-root", "relative"],
  ["--dependencies-only", "--no-service"],
])
  test(`invalid input ${args.join(" ")} has no side effects`, async (t) => {
    const ctx = await fixture(t);
    await assert.rejects(ctx.run(args), /option|value|absolute|combined/i);
    assert.equal(await ctx.readCalls(), "");
  });

for (const [name, overrides, message] of [
  ["old macOS", { osVersion: "13.6" }, /macOS 14/],
  ["root user", { uid: "0" }, /root/],
  ["unknown architecture", { machine: "mips" }, /architecture/],
  ["Rosetta", { machine: "x86_64", translated: "1" }, /native terminal/],
])
  test(`preflight rejects ${name} before invoking Node`, async (t) => {
    const ctx = await fixture(t, overrides);
    await assert.rejects(ctx.run(), message);
    assert.doesNotMatch(await ctx.readCalls(), /node|curl|brew|sudo|launchctl/);
  });

test("setup forwards resolved no-service paths as separately quoted arguments", async (t) => {
  const ctx = await fixture(t);
  await ctx.run([
    "--no-service",
    "--install-root",
    "/tmp/app root",
    "--data-dir",
    "/tmp/private data",
  ]);
  const calls = await ctx.readCalls();
  assert.match(calls, /release-install\.mjs/);
  assert.match(calls, /--install-root \/tmp\/app root --data-dir \/tmp\/private data/);
  assert.doesNotMatch(calls, /--service/);
});

test("dependency repair forwards only dependency options", async (t) => {
  const ctx = await fixture(t);
  await ctx.run(["--dependencies-only"]);
  const line = (await ctx.readCalls())
    .split("\n")
    .find((entry) => entry.includes("release-install.mjs"));
  assert.match(line, /--dependencies-only/);
  assert.doesNotMatch(line, /--install-root|--data-dir|--service|--resume|--channel/);
});

test("setup preserves a nonstandard Homebrew prefix in the bootstrap PATH", async (t) => {
  const ctx = await fixture(t);
  const prefix = path.join(ctx.root, "custom brew");
  await fs.mkdir(path.join(prefix, "bin"), { recursive: true });
  await fs.mkdir(path.join(prefix, "sbin"), { recursive: true });
  await fs.writeFile(
    path.join(ctx.root, "bin/brew"),
    `#!/bin/sh\necho "brew $*" >> "$FIXTURE_CALLS"\n[ "$1" = --prefix ] && printf '%s\\n' '${prefix}'\n`,
  );
  await fs.chmod(path.join(ctx.root, "bin/brew"), 0o755);
  await ctx.run(["--no-service"]);
  assert.match(
    await ctx.readCalls(),
    new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});
