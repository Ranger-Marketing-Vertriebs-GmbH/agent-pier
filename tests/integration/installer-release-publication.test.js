import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { renderOnlineInstaller } from "../../scripts/installer-package.mjs";
import { renderInstallerFormula } from "../../scripts/homebrew-formula.mjs";
const hash = (b) => createHash("sha256").update(b).digest("hex");

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-publish-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const version = "1.2.3";
  const write = async (file, bytes) => {
    await fs.writeFile(path.join(directory, file), bytes);
    return { file, sha256: hash(bytes), bytes: Buffer.byteLength(bytes) };
  };
  const artifacts = {};
  for (const platform of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"])
    artifacts[platform] = await write(
      `agentpier-${platform}.aprelease`,
      `fixture ${platform}`,
    );
  await write("latest.json", JSON.stringify({ version, schemaVersion: 1, artifacts }));
  const bundle = await write(`agentpier-installer-${version}.tar.gz`, "fixture bundle");
  const script = await write(
    "install-agentpier.sh",
    renderOnlineInstaller({ version, sha256: bundle.sha256 }),
  );
  await write("installer.json", JSON.stringify({ version, bundle, script }));
  await write("agentpier-installer.rb", renderInstallerFormula({ version, ...bundle }));
  return { directory, version, tag: `v${version}` };
}

test("release validation rejects missing, changed, or cross-version installer assets", async (t) => {
  const { validateInstallerRelease } =
    await import("../../scripts/installer-release-check.mjs");
  const ctx = await fixture(t);
  assert.equal((await validateInstallerRelease(ctx)).length, 9);
  await assert.rejects(
    validateInstallerRelease({ ...ctx, tag: "v9.9.9" }),
    /version|tag/i,
  );
  await fs.appendFile(path.join(ctx.directory, "install-agentpier.sh"), "tampered");
  await assert.rejects(validateInstallerRelease(ctx), /checksum|size|content/i);
  await fs.rm(path.join(ctx.directory, "install-agentpier.sh"));
  await assert.rejects(validateInstallerRelease(ctx), /ENOENT|missing/i);
});

async function remoteFixture(ctx, latestTag = null) {
  let release = null;
  const remote = new Map();
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[1] === "view") {
      if (args[2] === "--repo") {
        if (!latestTag) throw Error("release not found");
        return JSON.stringify({ tagName: latestTag });
      }
      if (!release) throw Error("HTTP 404: Not Found");
      return JSON.stringify({
        isDraft: release.draft,
        tagName: release.tag_name,
        assets: [...remote.keys()].map((name) => ({ name })),
      });
    }
    if (args[1] === "create") {
      release = { draft: true, tag_name: ctx.tag };
      return "";
    }
    if (args[1] === "upload") {
      for (const file of args.slice(3, args.indexOf("--repo")))
        remote.set(path.basename(file), await fs.readFile(file));
      return "";
    }
    if (args[1] === "download") {
      const name = args[args.indexOf("--pattern") + 1];
      const dir = args[args.indexOf("--dir") + 1];
      await fs.writeFile(path.join(dir, name), remote.get(name));
      return "";
    }
    if (args[1] === "edit") {
      release.draft = false;
      if (!args.includes("--latest=false")) latestTag = ctx.tag;
      return "";
    }
    throw Error(`Unexpected gh arguments ${args}`);
  };
  return {
    run,
    remote,
    calls,
    get latestTag() {
      return latestTag;
    },
    get release() {
      return release;
    },
  };
}

test("publication exposes latest only after all downloaded assets match and is retryable", async (t) => {
  const { publishInstallerRelease } =
    await import("../../scripts/installer-release-publish.mjs");
  const ctx = await fixture(t),
    remote = await remoteFixture(ctx);
  const result = await publishInstallerRelease({ ...ctx, run: remote.run });
  assert.equal(result.published, true);
  assert.equal(remote.release.draft, false);
  assert.equal(remote.remote.size, 9);
  const uploadCount = remote.calls.filter((a) => a[1] === "upload").length;
  const second = await publishInstallerRelease({ ...ctx, run: remote.run });
  assert.equal(second.published, false);
  assert.equal(remote.calls.filter((a) => a[1] === "upload").length, uploadCount);
});

test("publication leaves a corrupt upload as a draft", async (t) => {
  const { publishInstallerRelease } =
    await import("../../scripts/installer-release-publish.mjs");
  const ctx = await fixture(t),
    remote = await remoteFixture(ctx);
  const run = async (args) => {
    const result = await remote.run(args);
    if (args[1] === "upload")
      remote.remote.set("install-agentpier.sh", Buffer.from("bad"));
    return result;
  };
  await assert.rejects(publishInstallerRelease({ ...ctx, run }), /mismatch|checksum/i);
  assert.equal(remote.release.draft, true);
  assert.equal(
    remote.calls.some((a) => a[1] === "edit"),
    false,
  );
});

test("finishing an older draft preserves the newer latest channel", async (t) => {
  const { publishInstallerRelease } =
    await import("../../scripts/installer-release-publish.mjs");
  const ctx = await fixture(t),
    remote = await remoteFixture(ctx, "v2.0.0");
  await publishInstallerRelease({ ...ctx, run: remote.run });
  assert.equal(remote.release.draft, false);
  assert.equal(remote.latestTag, "v2.0.0");
});

test("a partially uploaded draft resumes without replacing existing verified assets", async (t) => {
  const { publishInstallerRelease } =
    await import("../../scripts/installer-release-publish.mjs");
  const ctx = await fixture(t),
    remote = await remoteFixture(ctx);
  const failUpload = async (args) => {
    if (args[1] === "upload") {
      remote.remote.set(path.basename(args[3]), await fs.readFile(args[3]));
      throw Error("network interrupted");
    }
    return remote.run(args);
  };
  await assert.rejects(
    publishInstallerRelease({ ...ctx, run: failUpload }),
    /network interrupted/,
  );
  const first = [...remote.remote.keys()][0];
  assert.equal(remote.release.draft, true);
  await publishInstallerRelease({ ...ctx, run: remote.run });
  assert.equal(remote.release.draft, false);
  assert.equal(remote.remote.size, 9);
  const upload = remote.calls.find((a) => a[1] === "upload");
  assert.equal(upload.includes(path.join(ctx.directory, first)), false);
});

for (const corruption of ["missing", "changed"])
  test(`published ${corruption} assets are never repaired in place`, async (t) => {
    const { publishInstallerRelease } =
      await import("../../scripts/installer-release-publish.mjs");
    const ctx = await fixture(t),
      remote = await remoteFixture(ctx);
    await publishInstallerRelease({ ...ctx, run: remote.run });
    if (corruption === "missing") remote.remote.delete("install-agentpier.sh");
    else remote.remote.set("install-agentpier.sh", Buffer.from("changed"));
    remote.calls.length = 0;
    await assert.rejects(
      publishInstallerRelease({ ...ctx, run: remote.run }),
      /incomplete|mismatch/,
    );
    assert.equal(
      remote.calls.some((a) => ["upload", "edit", "create"].includes(a[1])),
      false,
    );
  });

for (const file of [
  "latest.json",
  "installer.json",
  "agentpier-installer.rb",
  "agentpier-installer-1.2.3.tar.gz",
  "agentpier-darwin-arm64.aprelease",
  "agentpier-darwin-x64.aprelease",
  "agentpier-linux-arm64.aprelease",
  "agentpier-linux-x64.aprelease",
])
  test(`missing ${file} fails before GitHub is contacted`, async (t) => {
    const { publishInstallerRelease } =
      await import("../../scripts/installer-release-publish.mjs");
    const ctx = await fixture(t),
      remote = await remoteFixture(ctx);
    await fs.rm(path.join(ctx.directory, file));
    await assert.rejects(publishInstallerRelease({ ...ctx, run: remote.run }));
    assert.equal(remote.calls.length, 0);
  });
