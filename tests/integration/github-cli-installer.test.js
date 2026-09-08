import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  prepareGithubCli,
  unpackGithubRelease,
} from "../../server/features/tools/github-cli-installer.js";
import { ToolInstaller } from "../../server/features/tools/tool-installer.js";
import { existsSync } from "node:fs";
const sha = (data) => createHash("sha256").update(data).digest("hex");
const version = "2.100.0";
const binary = `#!${process.execPath}\nconsole.log('gh version ${version} (fixture)')\n`;
function archive(format, root, extra = [], program = binary) {
  const entries = [
    [`${root}/bin/gh`, program, "file"],
    [`${root}/LICENSE`, "Fixture MIT license", "file"],
    ...extra,
  ];
  const script = `import sys,json,io,zipfile,tarfile\ne=json.loads(sys.stdin.read());b=io.BytesIO()\nif sys.argv[1]=='zip':\n with zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as a:\n  for name,value,kind in e:\n   i=zipfile.ZipInfo(name);i.external_attr=((0o120777 if kind=='link' else 0o100755)<<16);a.writestr(i,value)\nelse:\n with tarfile.open(fileobj=b,mode='w:gz',format=tarfile.PAX_FORMAT) as a:\n  for name,value,kind in e:\n   i=tarfile.TarInfo(name);i.mode=0o755\n   if kind=='link': i.type=tarfile.SYMTYPE;i.linkname=value;a.addfile(i)\n   else: d=value.encode();i.size=len(d);a.addfile(i,io.BytesIO(d))\nsys.stdout.buffer.write(b.getvalue())\n`;
  const result = spawnSync("python3", ["-c", script, format], {
    input: JSON.stringify(entries),
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}
async function fixture(t, platform = "linux", arch = "x64", extra = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-gh-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const base = `gh_${version}_${platform === "darwin" ? "macOS" : "linux"}_${arch === "x64" ? "amd64" : "arm64"}`;
  const name = `${base}.${platform === "darwin" ? "zip" : "tar.gz"}`;
  const body = archive(platform === "darwin" ? "zip" : "tar", base, extra);
  const sumName = `gh_${version}_checksums.txt`;
  const sums = Buffer.from(`${sha(body)}  ${name}\n`);
  const url = (name) =>
    `https://github.com/cli/cli/releases/download/v${version}/${name}`;
  const release = {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      { name, size: body.length, browser_download_url: url(name) },
      { name: sumName, size: sums.length, browser_download_url: url(sumName) },
    ],
  };
  const calls = [];
  const fetchImpl = async (address, options) => {
    calls.push({ url: String(address), options });
    if (String(address) === "https://api.github.com/repos/cli/cli/releases/latest")
      return Response.json(release);
    if (String(address) === url(sumName)) return new Response(sums);
    if (String(address) === url(name)) return new Response(body);
    throw Error("Unexpected fixture URL");
  };
  return {
    dir,
    base,
    name,
    body,
    sums,
    release,
    url,
    fetchImpl,
    calls,
    options: { prefix: path.join(dir, "prefix"), platform, arch, fetchImpl },
  };
}
for (const platform of ["darwin", "linux"])
  for (const arch of ["x64", "arm64"])
    test(`official ${platform}/${arch} asset and checksum install only private gh binary and license`, async (t) => {
      const c = await fixture(t, platform, arch);
      const result = await prepareGithubCli(c.options);
      assert.equal(result.version, version);
      assert.equal(
        await fs.readFile(path.join(c.options.prefix, "bin/gh"), "utf8"),
        binary,
      );
      assert.equal(
        (await fs.stat(path.join(c.options.prefix, "bin/gh"))).mode & 0o777,
        0o700,
      );
      assert.equal(
        await fs.readFile(path.join(c.options.prefix, "LICENSE"), "utf8"),
        "Fixture MIT license",
      );
      for (const call of c.calls) {
        assert.equal(call.options.redirect, "manual");
        assert.equal(call.options.headers.Authorization, undefined);
        assert.equal(call.options.credentials, "omit");
      }
      assert.equal(c.calls.length, 3);
    });
test("checksum mismatch, missing asset and an unexpected release asset URL fail before extraction", async (t) => {
  const c = await fixture(t);
  c.sums.fill(48, 0, 64);
  await assert.rejects(prepareGithubCli(c.options), /Prüfsumme/);
  assert.equal(await fs.stat(c.options.prefix).catch(() => null), null);
  c.release.assets[0].browser_download_url = "https://evil.example/archive";
  await assert.rejects(prepareGithubCli(c.options), /Release/);
  c.release.assets = [];
  await assert.rejects(prepareGithubCli(c.options), /Release/);
});
test("only exact public GitHub release redirect origins are accepted and bounds cancel oversized downloads", async (t) => {
  const c = await fixture(t);
  const original = c.fetchImpl;
  for (const destination of [
    "http://release-assets.githubusercontent.com/a",
    "https://github.com.evil/a",
    "https://user:secret@github.com/a",
    "https://127.0.0.1/a",
  ])
    await assert.rejects(
      prepareGithubCli({
        ...c.options,
        fetchImpl: async (url, options) =>
          String(url) === c.url(c.name)
            ? new Response(null, { status: 302, headers: { location: destination } })
            : original(url, options),
      }),
      /Weiterleitung|Download/,
    );
  await assert.rejects(
    prepareGithubCli({
      ...c.options,
      fetchImpl: async (url, options) =>
        String(url) === c.url(c.name)
          ? new Response("tiny", {
              headers: { "content-length": String(65 * 1024 * 1024) },
            })
          : original(url, options),
    }),
    /groß|Größe/,
  );
  const allowed =
    "https://release-assets.githubusercontent.com/github-production-release-asset/fixture?signature=public-fixture";
  await prepareGithubCli({
    ...c.options,
    fetchImpl: async (url, options) =>
      String(url) === c.url(c.name)
        ? new Response(null, { status: 302, headers: { location: allowed } })
        : String(url) === allowed
          ? new Response(c.body)
          : original(url, options),
  });
});
test("ZIP and tar reject links, traversal and duplicate binaries; tar supports ordinary PAX long paths", async () => {
  for (const format of ["zip", "tar"])
    for (const extra of [
      [["gh_2.100.0_linux_amd64/link", "/outside", "link"]],
      [["../outside", "x", "file"]],
      [["gh_2.100.0_linux_amd64/bin/gh", "duplicate", "file"]],
    ])
      await assert.rejects(
        unpackGithubRelease(
          archive(format, "gh_2.100.0_linux_amd64", extra),
          format,
          "gh_2.100.0_linux_amd64",
        ),
        /Archiv|Pfad|Links|doppelt/,
      );
  const root = "gh_2.100.0_linux_amd64";
  assert.equal(
    (
      await unpackGithubRelease(
        archive("tar", root, [
          [`${root}/share/man/${"long-".repeat(30)}.1`, "fixture", "file"],
        ]),
        "tar",
        root,
      )
    )
      .get("bin/gh")
      .toString(),
    binary,
  );
});
test("abort and unsupported platforms never download or publish a binary", async (t) => {
  const c = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    prepareGithubCli({ ...c.options, signal: controller.signal }),
    /abgebrochen/,
  );
  assert.equal(c.calls.length, 0);
  await assert.rejects(
    prepareGithubCli({ ...c.options, platform: "win32" }),
    /unterstützt/,
  );
  assert.equal(c.calls.length, 0);
});
for (const platform of ["darwin", "linux"])
  test(`gh utility ${platform} installation is npm-independent and atomically activated after version verification`, async (t) => {
    const c = await fixture(t, platform);
    const destination = path.join(c.dir, "clis/gh");
    const detect = () => [
      { id: "gh", installed: existsSync(path.join(destination, "bin/gh")) },
    ];
    const installer = new ToolInstaller({
      dataDir: c.dir,
      home: c.dir,
      npmCli: null,
      platform,
      arch: "x64",
      detect,
      githubFetch: c.fetchImpl,
    });
    t.after(() => installer.close());
    const before = installer.list().installations.find((row) => row.tool === "gh");
    assert.equal(before?.available, true);
    assert.equal(before.utility, true);
    assert.equal(before.installer, "github-release");
    assert.equal(
      installer.list().installations.find((row) => row.tool === "codex").available,
      true,
    );
    installer.start("gh");
    assert.throws(() => installer.start("gh"), /läuft/);
    await installer.active.done;
    const result = installer.list().installations.find((row) => row.tool === "gh");
    assert.equal(result.status, "succeeded", result.message);
    assert.match(result.version, /^gh version 2\.100\.0/);
    assert.equal(result.installed, true);
    assert.equal((await fs.lstat(destination)).isSymbolicLink(), true);
    assert.ok((await fs.readlink(destination)).startsWith(".packages/"));
    assert.deepEqual(
      (await fs.readdir(path.join(c.dir, "clis"))).filter((x) =>
        x.startsWith(".install-"),
      ),
      [],
    );
    assert.throws(() => installer.start("gh"), /bereits installiert/);
  });
test("a bad gh checksum and a cancelled download leave no activation or staging files", async (t) => {
  const c = await fixture(t);
  c.sums.fill(48, 0, 64);
  const installer = new ToolInstaller({
    dataDir: c.dir,
    home: c.dir,
    npmCli: null,
    platform: "linux",
    arch: "x64",
    detect: () => [],
    githubFetch: c.fetchImpl,
  });
  t.after(() => installer.close());
  installer.start("gh");
  await installer.active.done;
  assert.equal(
    installer.list().installations.find((row) => row.tool === "gh").status,
    "failed",
  );
  assert.equal(existsSync(path.join(c.dir, "clis/gh")), false);
  assert.deepEqual(
    (await fs.readdir(path.join(c.dir, "clis"))).filter((x) => x.startsWith(".install-")),
    [],
  );
  let requested;
  const reached = new Promise((resolve) => {
    requested = resolve;
  });
  installer.githubFetch = async (url, { signal }) => {
    requested();
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(Error("fixture abort")), {
        once: true,
      });
    });
  };
  installer.start("gh");
  await reached;
  await installer.close();
  assert.equal(
    installer.list().installations.find((row) => row.tool === "gh").status,
    "failed",
  );
  assert.equal(existsSync(path.join(c.dir, "clis/gh")), false);
  assert.deepEqual(
    (await fs.readdir(path.join(c.dir, "clis"))).filter((x) => x.startsWith(".install-")),
    [],
  );
});
test("unexpected gh version never activates, and concurrent destination files remain untouched", async (t) => {
  const c = await fixture(t);
  const wrong = archive(
    "tar",
    c.base,
    [],
    `#!${process.execPath}\nconsole.log('gh version 0.0.1')\n`,
  );
  const destination = path.join(c.dir, "clis/gh");
  const installer = new ToolInstaller({
    dataDir: c.dir,
    home: c.dir,
    npmCli: null,
    platform: "linux",
    arch: "x64",
    detect: () => [],
    githubFetch: async (url, options) =>
      String(url) === c.url(c.name)
        ? new Response(wrong)
        : String(url).endsWith("_checksums.txt")
          ? new Response(`${sha(wrong)}  ${c.name}\n`)
          : c.fetchImpl(url, options),
  });
  t.after(() => installer.close());
  installer.start("gh");
  await installer.active.done;
  let result = installer.list().installations.find((row) => row.tool === "gh");
  assert.equal(result.status, "failed");
  assert.match(result.message, /Version/);
  assert.equal(existsSync(destination), false);
  installer.githubFetch = async (url, options) => {
    if (String(url) === c.url(c.name)) {
      await fs.mkdir(destination);
      await fs.writeFile(path.join(destination, "keep"), "concurrent owner");
    }
    return c.fetchImpl(url, options);
  };
  installer.start("gh");
  await installer.active.done;
  result = installer.list().installations.find((row) => row.tool === "gh");
  assert.equal(result.status, "failed");
  assert.equal(
    await fs.readFile(path.join(destination, "keep"), "utf8"),
    "concurrent owner",
  );
  assert.deepEqual(await fs.readdir(path.join(c.dir, "clis/.packages")), []);
  assert.deepEqual(
    (await fs.readdir(path.join(c.dir, "clis"))).filter((x) => x.startsWith(".install-")),
    [],
  );
});
