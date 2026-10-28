import test from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectTarget } from "../../server/features/assistants/project-paths.js";
import {
  listFolder,
  readFile,
  searchFolder,
  writeFile,
} from "../../server/features/assistants/project-files.js";
import { localRoot, walkLocal } from "../../server/features/sftp/sftp-local.js";

// AgentPier's data directory is refused by device and inode on every folder of a
// project path, so no other spelling of it gets past: another case on a file system
// that ignores case, or the /System/Volumes/Data firmlink on macOS, which realpath
// does not resolve. A project granted at `/` still never reaches it.
const darwin = process.platform === "darwin";
const firmlink = "/System/Volumes/Data";
const refused = { status: 403, key: "projectPathRefused" };

function host(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "data-identity-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, "app");
  const data = path.join(base, "AgentPier");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(path.join(data, "mail"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "a.txt"), "visible needle\n");
  fs.writeFileSync(path.join(data, "mail", "secret.txt"), "sealed needle\n");
  return { base, project, data, options: { protectedRoots: [data] } };
}

const caseInsensitive = (dir) => fs.existsSync(dir.toUpperCase());
// The same folder through the firmlink, when this Mac has one for it.
const viaFirmlink = (dir) =>
  darwin && fs.existsSync(firmlink + dir) ? firmlink + dir : null;

test("a project granted at / never reads the data directory", async (t) => {
  const h = host(t);
  const secret = path.join(h.data, "mail", "secret.txt");
  assert.throws(() => projectTarget("/", secret, h.options), refused);
  await assert.rejects(readFile("/", secret, h.options), refused);
  await assert.rejects(listFolder("/", h.data, h.options), refused);
  await assert.rejects(
    async () => writeFile("/", path.join(h.data, "new.txt"), "x", h.options),
    refused,
  );
});

test(
  "a project granted at / never reads the data directory in another case",
  { skip: !darwin && "case-insensitive file systems are tested on macOS" },
  async (t) => {
    const h = host(t);
    if (!caseInsensitive(h.data)) return t.skip("this volume is case-sensitive");
    const upper = path.join(h.data, "mail", "secret.txt").toUpperCase();
    const mixed = path.join(h.base, "aGENTpIER", "mail", "secret.txt");
    for (const raw of [upper, mixed]) {
      assert.equal(fs.readFileSync(raw, "utf8"), "sealed needle\n");
      assert.throws(() => projectTarget("/", raw, h.options), refused, raw);
      await assert.rejects(readFile("/", raw, h.options), refused, raw);
    }
    // The protected root itself configured in another case.
    const options = { protectedRoots: [h.data.toUpperCase()] };
    assert.throws(
      () => projectTarget("/", path.join(h.data, "mail", "secret.txt"), options),
      refused,
    );
    // A project granted at the data directory's parent in another case.
    assert.throws(
      () => projectTarget(h.base.toUpperCase(), "AGENTPIER/mail/secret.txt", h.options),
      refused,
    );
  },
);

test(
  "a project never reads the data directory through the /System/Volumes/Data firmlink",
  {
    skip:
      !darwin &&
      "the /System/Volumes/Data firmlink exists only on macOS (APFS volume group)",
  },
  async (t) => {
    const h = host(t);
    const spelled = viaFirmlink(h.data);
    if (!spelled) return t.skip("no /System/Volumes/Data firmlink for the temp folder");
    const secret = path.join(spelled, "mail", "secret.txt");
    assert.equal(fs.readFileSync(secret, "utf8"), "sealed needle\n");
    // Granted at /, at the firmlink's volume root and at the data's parent through it.
    for (const root of ["/", firmlink, viaFirmlink(h.base)]) {
      assert.throws(() => projectTarget(root, secret, h.options), refused, root);
      await assert.rejects(readFile(root, secret, h.options), refused, root);
      await assert.rejects(listFolder(root, spelled, h.options), refused, root);
      await assert.rejects(
        async () => writeFile(root, path.join(spelled, "planted.txt"), "x", h.options),
        refused,
        root,
      );
    }
    assert.equal(fs.existsSync(path.join(h.data, "planted.txt")), false);
    // A write that would replace a folder holding the data directory.
    assert.throws(
      () => projectTarget("/", viaFirmlink(h.base), { ...h.options, write: true }),
      refused,
    );
    // The project itself granted inside the data directory through the firmlink.
    assert.throws(() => projectTarget(spelled, "mail/secret.txt", h.options), refused);
  },
);

test(
  "a search or an upload walk through the firmlink skips the data directory",
  {
    skip:
      !darwin &&
      "the /System/Volumes/Data firmlink exists only on macOS (APFS volume group)",
  },
  async (t) => {
    const h = host(t);
    const root = viaFirmlink(h.base);
    if (!root) return t.skip("no /System/Volumes/Data firmlink for the temp folder");
    const { matches } = await searchFolder(root, "", "needle", h.options);
    assert.deepEqual(
      matches.map((m) => m.path),
      ["app/src/a.txt"],
    );
    const target = localRoot({ root, raw: "", protectedRoots: h.options.protectedRoots });
    const { entries } = await walkLocal(target, { excludes: [] });
    assert.deepEqual(
      entries.map((e) => e.path),
      ["app/src/a.txt"],
    );
  },
);

test("a protected root whose identity cannot be determined refuses (fail closed)", (t) => {
  const h = host(t);
  const options = { protectedRoots: [path.join(h.base, "missing-data")] };
  assert.throws(() => projectTarget(h.project, "src/a.txt", options), refused);
});

test("links and hard links into the data directory stay refused", async (t) => {
  const h = host(t);
  fs.symlinkSync(h.data, path.join(h.project, "data-link"));
  assert.throws(
    () => projectTarget(h.project, "data-link/mail/secret.txt", h.options),
    refused,
  );
  assert.throws(
    () => projectTarget("/", path.join(h.project, "data-link"), h.options),
    refused,
  );
  // A hard link to a file of the data directory is never read as a project file.
  fs.linkSync(path.join(h.data, "mail", "secret.txt"), path.join(h.project, "hard.txt"));
  await assert.rejects(readFile(h.project, "hard.txt", h.options), {
    status: 400,
    key: "projectFileUnsuitable",
  });
});

test("a write never lands in the installed application; a read still may", async (t) => {
  const h = host(t);
  const install = path.join(h.base, "agentpier-app");
  fs.mkdirSync(path.join(install, "current", "server"), { recursive: true });
  fs.writeFileSync(path.join(install, "current", "server", "index.js"), "// app\n");
  const previous = process.env.AGENTPIER_INSTALL_ROOT;
  process.env.AGENTPIER_INSTALL_ROOT = install;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTPIER_INSTALL_ROOT;
    else process.env.AGENTPIER_INSTALL_ROOT = previous;
  });
  const code = path.join(install, "current", "server", "index.js");
  await assert.rejects(async () => writeFile("/", code, "planted", h.options), refused);
  await assert.rejects(
    async () => writeFile(h.base, "agentpier-app/current/new.js", "x", h.options),
    refused,
  );
  assert.equal(fs.readFileSync(code, "utf8"), "// app\n");
  assert.match((await readFile("/", code, h.options)).content, /app/);
  // Through the firmlink, when this Mac has one for the temp folder.
  const spelled = viaFirmlink(code);
  if (spelled)
    await assert.rejects(async () => writeFile("/", spelled, "x", h.options), refused);
  // Writes elsewhere in the project are unaffected.
  await writeFile(h.project, "src/b.txt", "fine", h.options);
});

test("a protected root that cannot be identified logs one line naming the cause", (t) => {
  const h = host(t);
  const module = new URL(
    "../../server/features/assistants/protected-dirs.js",
    import.meta.url,
  );
  const script = `
    const { protectedDirs } = await import(${JSON.stringify(module.href)});
    for (let i = 0; i < 3; i++) try { protectedDirs([process.argv[1]]); } catch {}
  `;
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, path.join(h.base, "missing")],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stderr.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /PROTECTED_ROOT_UNAVAILABLE, ENOENT/);
  assert.doesNotMatch(lines[0], /missing|\//);
});

test("an install root that does not exist protects nothing and refuses no write", async (t) => {
  const h = host(t);
  const previous = process.env.AGENTPIER_INSTALL_ROOT;
  process.env.AGENTPIER_INSTALL_ROOT = path.join(h.base, "no-such-install");
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTPIER_INSTALL_ROOT;
    else process.env.AGENTPIER_INSTALL_ROOT = previous;
  });
  await writeFile(h.project, "src/c.txt", "fine", h.options);
  assert.equal(fs.readFileSync(path.join(h.project, "src", "c.txt"), "utf8"), "fine");
  // The data directory stays fail closed.
  const missingData = { protectedRoots: [path.join(h.base, "missing-data")] };
  await assert.rejects(
    async () => writeFile(h.project, "src/d.txt", "x", missingData),
    refused,
  );
});
