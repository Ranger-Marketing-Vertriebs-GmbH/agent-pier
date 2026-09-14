import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-bundle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await fs.mkdir(source);
  for (const dir of ["scripts", "server", "vendor"])
    await fs.mkdir(path.join(source, dir));
  for (const [name, text] of Object.entries({
    "package.json": '{"version":"1.2.3","type":"module"}',
    LICENSE: "license",
    "THIRD_PARTY_NOTICES.md": "notices",
    "scripts/setup.sh": '#!/bin/sh\ncat "$(dirname "$0")/../installer-version"\n',
    "server/entry.js": "export const ready = true;\n",
    "vendor/notice.txt": "vendored",
  }))
    await fs.writeFile(path.join(source, name), text);
  execFileSync("git", ["init", "-q", source]);
  execFileSync("git", ["-C", source, "add", "."]);
  await fs.writeFile(path.join(source, "server/private-profile.json"), "secret");
  const outputDir = path.join(root, "output");
  await fs.mkdir(outputDir);
  return { source, outputDir, root };
}

test("installer bundle extracts independently, excludes untracked data, and is reproducible", async (t) => {
  const { buildInstaller } = await import("../../scripts/installer-package.mjs");
  const ctx = await fixture(t);
  const result = await buildInstaller({ ...ctx, version: "1.2.3" });
  const bundle = path.join(ctx.outputDir, result.bundle.file);
  const bytes = await fs.readFile(bundle);
  assert.equal(result.bundle.sha256, createHash("sha256").update(bytes).digest("hex"));
  const extracted = path.join(ctx.root, "extracted");
  await fs.mkdir(extracted);
  execFileSync("tar", ["-xzf", bundle, "-C", extracted]);
  assert.equal(
    execFileSync("sh", [path.join(extracted, "scripts/setup.sh")], {
      encoding: "utf8",
    }).trim(),
    "1.2.3",
  );
  await assert.rejects(fs.access(path.join(extracted, "server/private-profile.json")));
  await assert.rejects(fs.access(path.join(extracted, ".git")));
  await fs.utimes(path.join(ctx.source, "server/entry.js"), new Date(), new Date());
  const second = await buildInstaller({ ...ctx, version: "1.2.3" });
  assert.equal(second.bundle.sha256, result.bundle.sha256);
});

test("installer packaging rejects a version mismatch and source symlinks", async (t) => {
  const { buildInstaller } = await import("../../scripts/installer-package.mjs");
  const ctx = await fixture(t);
  await assert.rejects(buildInstaller({ ...ctx, version: "1.2.4" }), /version/i);
  await fs.symlink("/etc/passwd", path.join(ctx.source, "server/link"));
  execFileSync("git", ["-C", ctx.source, "add", "server/link"]);
  await assert.rejects(buildInstaller({ ...ctx, version: "1.2.3" }), /link|regular/i);
});
