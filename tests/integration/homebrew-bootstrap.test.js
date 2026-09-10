import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const script = path.resolve("scripts/install-homebrew.sh");
async function fixture(
  t,
  { existing = false, downloadFails = false, installFails = false, noBrew = false } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-brew-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"),
    temporary = path.join(root, "tmp");
  await fs.mkdir(bin);
  await fs.mkdir(temporary);
  for (const name of ["mktemp", "rm"]) {
    const system = await fs
      .access(`/usr/bin/${name}`)
      .then(() => `/usr/bin/${name}`)
      .catch(() => `/bin/${name}`);
    await fs.symlink(system, path.join(bin, name));
  }
  async function tool(name, body) {
    await fs.writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`);
    await fs.chmod(path.join(bin, name), 0o755);
  }
  if (existing) await tool("brew", "exit 0");
  await tool(
    "curl",
    `printf '%s\\n' "$@" > "$FIXTURE_ROOT/download-args"
${downloadFails ? "exit 22" : ""}
while [ "$1" != -o ]; do shift; done
shift
/bin/cat > "$1" <<'INSTALLER'
echo "$NONINTERACTIVE" > "$FIXTURE_ROOT/installer-ran"
${installFails ? "exit 1" : ""}
${
  noBrew
    ? "exit 0"
    : `printf '#!/bin/sh\\nexit 0\\n' > "$FIXTURE_ROOT/bin/brew"
/bin/chmod 755 "$FIXTURE_ROOT/bin/brew"`
}
INSTALLER`,
  );
  return {
    root,
    temporary,
    run: () =>
      execute("/bin/sh", [script], {
        env: { PATH: bin, TMPDIR: temporary, FIXTURE_ROOT: root },
      }),
  };
}

test("existing Homebrew is reused without a download", async (t) => {
  const ctx = await fixture(t, { existing: true });
  await ctx.run();
  await assert.rejects(fs.access(path.join(ctx.root, "download-args")), {
    code: "ENOENT",
  });
});

test("missing system curl reports the bootstrap prerequisite without starting installation", async (t) => {
  const ctx = await fixture(t);
  await fs.unlink(path.join(ctx.root, "bin/curl"));
  await assert.rejects(ctx.run(), /macOS system curl is unavailable/);
  assert.deepEqual(await fs.readdir(ctx.temporary), []);
});

test("official installer download runs noninteractively, verifies brew, and removes temporary files", async (t) => {
  const ctx = await fixture(t);
  await ctx.run();
  const args = await fs.readFile(path.join(ctx.root, "download-args"), "utf8");
  assert.match(
    args,
    /https:\/\/raw\.githubusercontent\.com\/Homebrew\/install\/HEAD\/install\.sh/,
  );
  assert.match(args, /--proto-redir\n=https/);
  assert.equal(await fs.readFile(path.join(ctx.root, "installer-ran"), "utf8"), "1\n");
  assert.deepEqual(await fs.readdir(ctx.temporary), []);
});

for (const failure of ["downloadFails", "installFails", "noBrew"])
  test(`Homebrew bootstrap stops and cleans up after ${failure}`, async (t) => {
    const ctx = await fixture(t, { [failure]: true });
    await assert.rejects(ctx.run());
    assert.deepEqual(await fs.readdir(ctx.temporary), []);
    if (failure === "downloadFails")
      await assert.rejects(fs.access(path.join(ctx.root, "installer-ran")), {
        code: "ENOENT",
      });
  });
