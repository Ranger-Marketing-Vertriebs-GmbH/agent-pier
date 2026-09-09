import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolInstaller } from "../../server/features/tools/tool-installer.js";
import { detectTools } from "../../server/features/accounts/account-store.js";

async function fixture(t, tool, { legacy = false, fail = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ap-tool-update-"));
  const home = path.join(root, "home");
  const native = path.join(
    home,
    tool === "opencode" ? ".opencode/bin" : ".local/bin",
    tool,
  );
  const managed = path.join(root, "clis", tool);
  const old = path.join(root, "clis/.packages/old");
  const binary = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 9.8.7; exit 0; fi\nprintf '%s\\n' "$@" > '${root}/args'\nprintf '%s' "$HOME" > '${root}/home-used'\nexit ${fail ? 1 : 0}\n`;
  await fs.mkdir(path.dirname(native), { recursive: true });
  if (legacy) {
    await fs.mkdir(path.join(old, "bin"), { recursive: true });
    await fs.writeFile(path.join(old, "bin", tool), "#!/bin/sh\necho 1.2.3\n", {
      mode: 0o700,
    });
    await fs.symlink(".packages/old", managed);
  } else await fs.writeFile(native, binary, { mode: 0o700 });
  const detect = () => detectTools({ HOME: home, PATH: path.join(managed, "bin") }, true);
  let downloads = 0;
  const installer = new ToolInstaller({
    dataDir: root,
    home,
    detect,
    npmCli: null,
    nativeFetch: async () => {
      downloads++;
      return new Response(
        fail
          ? "#!/bin/sh\nexit 1\n"
          : `#!/bin/sh\ncat > '${native}' <<'BIN'\n${binary}BIN\nchmod 700 '${native}'\n`,
      );
    },
  });
  t.after(async () => {
    await installer.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    home,
    native,
    managed,
    old,
    installer,
    detect,
    downloads: () => downloads,
  };
}

for (const tool of ["codex", "claude", "opencode"]) {
  test(`${tool} update invokes its native updater and verifies the installed version`, async (t) => {
    const f = await fixture(t, tool);
    assert.equal(f.installer.startUpdate(tool).status, "running");
    assert.throws(() => f.installer.startUpdate(tool), /läuft/);
    await f.installer.active.done;
    const job = f.installer.list().installations.find((item) => item.tool === tool);
    assert.equal(job.status, "succeeded", job.message);
    assert.equal(job.version, "9.8.7");
    assert.equal(
      await fs.readFile(path.join(f.root, "args"), "utf8"),
      tool === "opencode" ? "upgrade\n--method\ncurl\n" : "update\n",
    );
    assert.equal(await fs.readFile(path.join(f.root, "home-used"), "utf8"), f.home);
    assert.equal(f.downloads(), 0);
  });
  test(`${tool} migrates owned npm activation only after native installation succeeds`, async (t) => {
    const f = await fixture(t, tool, { legacy: true });
    const before = await fs.readlink(f.managed);
    f.installer.startUpdate(tool);
    assert.equal(await fs.readlink(f.managed), before);
    await f.installer.active.done;
    const job = f.installer.list().installations.find((item) => item.tool === tool);
    assert.equal(job.status, "succeeded", job.message);
    assert.equal(
      await fs.realpath(f.detect().find((item) => item.id === tool).path),
      await fs.realpath(f.native),
    );
    assert.match(await fs.readFile(path.join(f.old, "bin", tool), "utf8"), /1\.2\.3/);
    assert.equal(f.downloads(), 1);
  });
}

test("failed native migration preserves the old executable and activation", async (t) => {
  const f = await fixture(t, "codex", { legacy: true, fail: true });
  f.installer.startUpdate("codex");
  await f.installer.active.done;
  assert.equal(
    f.installer.list().installations.find((item) => item.tool === "codex").status,
    "failed",
  );
  assert.equal(await fs.readlink(f.managed), ".packages/old");
});

test("updates reject unsupported tools and unmanaged binaries before execution", async (t) => {
  const f = await fixture(t, "claude");
  assert.throws(() => f.installer.startUpdate("gh"));
  assert.throws(() => f.installer.startUpdate("claude;pwd"));
  await fs.mkdir(path.join(f.managed, "bin"), { recursive: true });
  await fs.writeFile(path.join(f.managed, "bin/claude"), "#!/bin/sh\nexit 0\n", {
    mode: 0o700,
  });
  assert.throws(() => f.installer.startUpdate("claude"), /native|verwaltet/i);
  assert.equal(f.downloads(), 0);
});
