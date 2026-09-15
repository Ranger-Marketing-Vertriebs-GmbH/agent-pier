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
  await fs.mkdir(path.join(root, "server/lib"), { recursive: true });
  await fs.copyFile(
    path.resolve("server/lib/is-main-module.js"),
    path.join(root, "server/lib/is-main-module.js"),
  );
  for (const name of [
    "setup.sh",
    "setup-options.mjs",
    "install.sh",
    "install-bootstrap.sh",
  ])
    await fs.copyFile(path.resolve("scripts", name), path.join(scripts, name));
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(root, "installer-version"), "1.17.0\n");
  const platformFixture = path.join(root, "platform.cjs");
  await fs.writeFile(
    platformFixture,
    'Object.defineProperty(process, "platform", { value: "darwin" });\nObject.defineProperty(process, "arch", { value: "arm64" });\n',
  );
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
    `if [ "$(basename "$1")" = setup-options.mjs ]; then exec ${JSON.stringify(process.execPath)} --require "$FIXTURE_PLATFORM" "$@"; fi
printf 'node-argc=%s\n' "$#" >> "$FIXTURE_CALLS"
for argument in "$@"; do printf 'node-arg=%s\n' "$argument" >> "$FIXTURE_CALLS"; done`,
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
          FIXTURE_PLATFORM: platformFixture,
          ...env,
        },
      }),
    readCalls: () => fs.readFile(calls, "utf8").catch(() => ""),
  };
}

for (const [name, args, output] of [
  ["help", ["--help"], /AgentPier setup/],
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
  ["--install-root", "/tmp/app/", "--data-dir", "/tmp/app/data"],
  ["--install-root", "/tmp/./app", "--data-dir", "/tmp/app/data"],
  ["--dependencies-only", "--no-service"],
])
  test(`invalid input ${args.join(" ")} has no side effects`, async (t) => {
    const ctx = await fixture(t);
    await assert.rejects(
      ctx.run(args),
      /option|value|absolute|combined|outside|normalized/i,
    );
    assert.equal(await ctx.readCalls(), "");
  });

test("filesystem root is rejected as an install root before side effects", async (t) => {
  const ctx = await fixture(t);
  await assert.rejects(
    ctx.run(["--install-root", "/", "--data-dir", "/tmp/data"]),
    /filesystem root/,
  );
  assert.equal(await ctx.readCalls(), "");
});

for (const [name, overrides, message] of [
  ["old macOS", { osVersion: "13.6" }, /macOS 14/],
  ["single-digit macOS", { osVersion: "9.6" }, /macOS 14/],
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
  assert.match(calls, /node-arg=\/tmp\/app root/);
  assert.match(calls, /node-arg=\/tmp\/private data/);
  assert.match(calls, /node-argc=8/);
  assert.doesNotMatch(calls, /--service/);
});

test("importing setup options with setup-like environment has no side effect", async (t) => {
  const ctx = await fixture(t);
  const moduleUrl = new URL(`file://${path.join(ctx.root, "scripts/setup-options.mjs")}`);
  await execute(
    process.execPath,
    ["--input-type=module", "-e", `import(${JSON.stringify(moduleUrl.href)})`],
    {
      env: {
        ...process.env,
        AGENTPIER_SETUP_RUN: "1",
        FIXTURE_CALLS: ctx.calls,
      },
    },
  );
  assert.equal(await ctx.readCalls(), "");
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
  const releaseInvocation = (await ctx.readCalls())
    .split("\n")
    .find((line) => line.startsWith("node ") && line.includes("release-install.mjs"));
  assert.match(
    releaseInvocation,
    new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("setup reuses one verified temporary Node bootstrap for delegation", async (t) => {
  const ctx = await fixture(t);
  const bin = path.join(ctx.root, "bin");
  await fs.writeFile(path.join(bin, "node"), "#!/bin/sh\nexit 1\n");
  await fs.writeFile(
    path.join(bin, "curl"),
    `#!/bin/sh
echo curl >> "$FIXTURE_CALLS"
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then output=$2; shift; fi
  shift
done
case "$output" in
  *checksums) echo 'abc node-v22.22.2-darwin-arm64.tar.gz' > "$output";;
  *) echo archive > "$output";;
esac
`,
  );
  await fs.writeFile(path.join(bin, "sha256sum"), "#!/bin/sh\necho 'abc  fixture'\n");
  await fs.writeFile(
    path.join(bin, "tar"),
    `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = -C ]; then target=$2; shift; fi
  shift
done
printf '%s\n' '#!/bin/sh' \
  'echo "bootstrap-node $*" >> "$FIXTURE_CALLS"' \
  'if [ "$1" = -e ]; then exit 0; fi' \
  'if [ "$(basename "$1")" = setup-options.mjs ]; then exec ${process.execPath} --require "$FIXTURE_PLATFORM" "$@"; fi' \
  'printf "node-argc=%s\\n" "$#" >> "$FIXTURE_CALLS"' \
  'for argument in "$@"; do printf "node-arg=%s\\n" "$argument" >> "$FIXTURE_CALLS"; done' \
  > "$target/node"
chmod 755 "$target/node"
`,
  );
  for (const name of ["node", "curl", "sha256sum", "tar"])
    await fs.chmod(path.join(bin, name), 0o755);

  await ctx.run(["--no-service"]);
  const calls = await ctx.readCalls();
  assert.equal(calls.split("\n").filter((line) => line === "curl").length, 2);
  assert.match(calls, /bootstrap-node .*setup-options\.mjs/);
  assert.match(calls, /bootstrap-node -e/);
  assert.match(calls, /node-arg=.*release-install\.mjs/);
});
