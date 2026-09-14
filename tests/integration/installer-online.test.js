import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
const exec = promisify(execFile);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-online-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  const tool = async (name, body) => {
    await fs.writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  await tool("uname", 'case "$1" in -s) echo Darwin;; -m) echo arm64;; esac');
  await tool("sw_vers", "echo 14.0");
  await tool("sysctl", "echo 0");
  await tool("id", "echo 501");
  await tool(
    "curl",
    'echo "$*" >> "$CALLS"\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; cp "$BUNDLE" "$1"; fi; shift; done\nexit "${CURL_EXIT:-0}"',
  );
  return {
    root,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CALLS: path.join(root, "calls"),
      SETUP_LOG: path.join(root, "setup"),
    },
  };
}

async function script(t, members) {
  const { createInstallerTar, renderOnlineInstaller } =
    await import("../../scripts/installer-package.mjs");
  const ctx = await fixture(t);
  const bytes = gzipSync(createInstallerTar(members));
  ctx.env.BUNDLE = path.join(ctx.root, "bundle.tar.gz");
  await fs.writeFile(ctx.env.BUNDLE, bytes);
  const content = renderOnlineInstaller({
    version: "1.2.3",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  ctx.script = path.join(ctx.root, "install.sh");
  await fs.writeFile(ctx.script, content);
  ctx.run = (args = [], overrides = {}) =>
    exec("/bin/sh", [ctx.script, ...args], { env: { ...ctx.env, ...overrides } });
  return ctx;
}
const setup = {
  name: "scripts/setup.sh",
  content: Buffer.from('printf "%s\\n" "$@" > "$SETUP_LOG"\nexit 7\n'),
  mode: 0o755,
};

test("online installer downloads a pinned bundle, forwards arguments, and preserves setup exit", async (t) => {
  const ctx = await script(t, [setup]);
  await assert.rejects(ctx.run(["--no-service", "--data-dir", "/a path"]), { code: 7 });
  assert.equal(
    await fs.readFile(ctx.env.SETUP_LOG, "utf8"),
    "--no-service\n--data-dir\n/a path\n",
  );
  assert.match(
    await fs.readFile(ctx.env.CALLS, "utf8"),
    /releases\/download\/v1\.2\.3\/agentpier-installer-1\.2\.3\.tar\.gz/,
  );
});

test("online help and invalid arguments never download or execute setup", async (t) => {
  const ctx = await script(t, [setup]);
  assert.match((await ctx.run(["--help"])).stdout, /AgentPier/);
  await assert.rejects(ctx.run(["--unknown"]), /option/i);
  await assert.rejects(ctx.run(["--data-dir", "relative"]), /absolute/i);
  await assert.rejects(fs.access(ctx.env.CALLS));
});

test("online installer never executes incomplete or checksum-mismatched downloads", async (t) => {
  const ctx = await script(t, [setup]);
  await assert.rejects(ctx.run([], { CURL_EXIT: "22" }));
  await fs.appendFile(ctx.env.BUNDLE, "tampered");
  await assert.rejects(ctx.run(), /checksum/i);
  await assert.rejects(fs.access(ctx.env.SETUP_LOG));
});

for (const kind of ["traversal", "symlink"]) {
  test(`online installer rejects a checksum-valid ${kind} archive before extraction`, async (t) => {
    const { createInstallerTar, renderOnlineInstaller } =
      await import("../../scripts/installer-package.mjs");
    const ctx = await fixture(t);
    const tar = createInstallerTar([setup]);
    if (kind === "traversal") {
      tar.fill(0, 0, 100);
      tar.write("../outside", 0);
    } else {
      tar.write("2", 156);
      tar.write("/tmp/outside", 157);
    }
    tar.fill(32, 148, 156);
    const sum = tar.subarray(0, 512).reduce((total, byte) => total + byte, 0);
    tar.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    const bytes = gzipSync(tar);
    ctx.env.BUNDLE = path.join(ctx.root, "bundle.tar.gz");
    await fs.writeFile(ctx.env.BUNDLE, bytes);
    const file = path.join(ctx.root, "install.sh");
    await fs.writeFile(
      file,
      renderOnlineInstaller({
        version: "1.2.3",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    );
    await assert.rejects(
      exec("/bin/sh", [file], { env: ctx.env }),
      /Unsafe|links|special/,
    );
    await assert.rejects(fs.access(ctx.env.SETUP_LOG));
    await assert.rejects(fs.access(path.join(ctx.root, "outside")));
  });
}

for (const kind of ["truncated gzip", "sparse extension"]) {
  test(`online installer rejects checksum-valid ${kind} before setup`, async (t) => {
    const { createInstallerTar, renderOnlineInstaller } =
      await import("../../scripts/installer-package.mjs");
    const ctx = await fixture(t);
    let bytes;
    if (kind === "truncated gzip")
      bytes = gzipSync(createInstallerTar([setup])).subarray(0, -8);
    else {
      const record = (text) => {
        let size = text.length + 3;
        while (`${size} ${text}\n`.length !== size) size = `${size} ${text}\n`.length;
        return `${size} ${text}\n`;
      };
      const tar = createInstallerTar([
        {
          name: "a-pax",
          content: Buffer.from(
            record("GNU.sparse.map=0,1") + record("GNU.sparse.size=67108865"),
          ),
        },
        { name: "b-sparse", content: Buffer.from("x") },
        setup,
      ]);
      tar.write("x", 156);
      tar.fill(32, 148, 156);
      const sum = tar.subarray(0, 512).reduce((total, byte) => total + byte, 0);
      tar.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
      bytes = gzipSync(tar);
    }
    ctx.env.BUNDLE = path.join(ctx.root, "bundle.tar.gz");
    await fs.writeFile(ctx.env.BUNDLE, bytes);
    const file = path.join(ctx.root, "install.sh");
    await fs.writeFile(
      file,
      renderOnlineInstaller({
        version: "1.2.3",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    );
    await assert.rejects(
      exec("/bin/sh", [file], { env: ctx.env }),
      kind === "sparse extension" ? /[Uu]nsafe|[Uu]nsupported/ : /gzip|compressed/,
    );
    await assert.rejects(fs.access(ctx.env.SETUP_LOG));
  });
}
