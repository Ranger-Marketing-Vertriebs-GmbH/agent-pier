import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  pypiIndexRegistry,
  pythonAdapter,
} from "../../server/features/mcp-packages/python-adapter.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const wheelBytes = Buffer.from("wheel");
const otherWheel = Buffer.from("platform wheel");
const sdistBytes = Buffer.from("sdist");
const host = "https://files.pythonhosted.org/packages";
const python = {
  kind: "python",
  directory: "/tc/python-3.14.7+1-uv0.12.21-test",
  uvPath: "/tc/uv/uv",
  pythonPath: "/tc/cpython/bin/python3",
  uvVersion: "0.12.21",
  pythonVersion: "3.14.7",
};
const ref = { registry: "pypi", name: "srv-x", version: "1.0" };
const file = (filename, bytes, extra = {}) => ({
  filename,
  url: `${host}/${filename}`,
  digests: { sha256: sha(bytes) },
  packagetype: filename.endsWith(".whl") ? "bdist_wheel" : "sdist",
  yanked: false,
  ...extra,
});
const release = () => [
  file("srv_x-1.0-cp314-cp314-macosx_11_0_arm64.whl", otherWheel),
  file("srv_x-1.0-py3-none-any.whl", wheelBytes),
  file("srv_x-1.0.tar.gz", sdistBytes),
];
const lockOf = (...hashes) =>
  `srv-x==1.0 \\\n${hashes.map((h) => `    --hash=sha256:${h}`).join(" \\\n")}\n`;
const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-py-adapter-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** The adapter's preview over a fake PyPI and a fake uv/CPython. */
function setup(
  t,
  {
    files = release(),
    lock = lockOf(sha(wheelBytes), sha(sdistBytes)),
    entryPoints = "[console_scripts]\nsrv-x = srv_x:main\n",
    registry = pypiIndexRegistry,
    noWheels = false,
    reader,
  } = {},
) {
  const downloads = [];
  const calls = [];
  const blobs = new Map([
    [sha(wheelBytes), wheelBytes],
    [sha(otherWheel), otherWheel],
    [sha(sdistBytes), sdistBytes],
  ]);
  const download = async (url) => {
    downloads.push(url);
    if (url === `${registry.api}/pypi/srv-x/json`)
      return Buffer.from(
        JSON.stringify({ info: { version: "1.0" }, releases: { "1.0": files } }),
      );
    const hit = files.find((f) => f.url === url && !f.filename.startsWith("gone"));
    if (hit) return blobs.get(hit.digests.sha256) ?? Buffer.from("tampered");
    throw Object.assign(Error("missing"), { status: 404 });
  };
  const execute = async (program, args) => {
    calls.push([program, ...args]);
    if (program === python.pythonPath) {
      if (reader) return reader(args);
      return { stdout: entryPoints, stderr: "" };
    }
    if (args[1] === "compile") {
      if (noWheels && args.includes("--only-binary"))
        throw Object.assign(Error("uv"), {
          stdout: "",
          stderr: "srv-x has no usable wheels",
        });
      fs.writeFileSync(args[args.indexOf("-o") + 1], lock);
    }
    return { stdout: "", stderr: "" };
  };
  const stage = tmp(t);
  const preview = (extra = {}) =>
    pythonAdapter.preview({
      ref,
      allowScripts: false,
      toolchain: async () => python,
      stage,
      registry,
      download,
      cacheDir: path.join(stage, "cache"),
      execute,
      environment: {},
      ...extra,
    });
  return { preview, downloads, calls, stage };
}

test("a preview reads the pure wheel's scripts and pins the release's PyPI digests", async (t) => {
  const { preview, downloads } = setup(t);
  const result = await preview();
  assert.deepEqual(result.programs, [{ name: "srv-x", path: "srv-x" }]);
  assert.equal(result.needsScripts, false);
  assert.equal(result.manifestText, "srv-x==1.0\n");
  assert.equal(result.lockText, lockOf(sha(wheelBytes), sha(sdistBytes)));
  assert.deepEqual(result.dependencies, [
    { name: "srv-x", version: "1.0", path: "srv-x" },
  ]);
  assert.match(result.digest, /^[0-9a-f]{64}$/);
  assert.equal(
    result.integrity,
    [sha(otherWheel), sha(wheelBytes), sha(sdistBytes)]
      .sort()
      .map((d) => `sha256:${d}`)
      .join(" "),
  );
  // The confirmation names the file the install uses with its digest.
  assert.deepEqual(result.installFile, {
    filename: "srv_x-1.0-py3-none-any.whl",
    sha256: sha(wheelBytes),
  });
  assert.ok(downloads.includes(`${host}/srv_x-1.0-py3-none-any.whl`));
  assert.ok(!downloads.some((url) => url.includes("cp314")));
});

test("only sha256 files from files.pythonhosted.org that are not yanked count", async (t) => {
  const files = [
    file("srv_x-1.0-py3-none-any.whl", wheelBytes, { yanked: true }),
    file("srv_x-1.0-cp314-cp314-macosx_11_0_arm64.whl", otherWheel, {
      url: "https://evil.test/srv_x-1.0-cp314-cp314-macosx_11_0_arm64.whl",
    }),
    { ...file("srv_x-1.0-py2-none-any.whl", wheelBytes), digests: {} },
    file("srv_x-1.0.tar.gz", sdistBytes),
  ];
  // The lock names the yanked wheel's hash: not vouched for, so refused.
  const yanked = setup(t, { files, lock: lockOf(sha(wheelBytes), sha(sdistBytes)) });
  await assert.rejects(yanked.preview(), { code: "MCP_PACKAGE_INTEGRITY_MISMATCH" });
  // The foreign wheel was never downloaded; only the sdist counts, so no programs yet.
  const ok = setup(t, { files, lock: lockOf(sha(sdistBytes)) });
  const result = await ok.preview();
  assert.deepEqual(result.programs, []);
  assert.equal(result.integrity, `sha256:${sha(sdistBytes)}`);
  assert.ok(!ok.downloads.some((url) => url.startsWith("https://evil.test")));
  const foreign = setup(t, {
    files: [file("srv_x-1.0.tar.gz", sdistBytes, { url: "https://evil.test/x.tar.gz" })],
  });
  await assert.rejects(foreign.preview(), { code: "MCP_PACKAGE_FOREIGN_SOURCE" });
});

test("an injected test index may serve its files from any host", async (t) => {
  const registry = { api: "http://127.0.0.1:1", index: "http://127.0.0.1:1/simple" };
  const files = release().map((f) => ({
    ...f,
    url: `${registry.api}/files/${f.filename}`,
  }));
  const { preview } = setup(t, { files, registry });
  assert.deepEqual((await preview()).programs, [{ name: "srv-x", path: "srv-x" }]);
});

test("a wheel that does not match its digest or cannot be downloaded is refused", async (t) => {
  const tampered = release();
  tampered[1] = { ...tampered[1], digests: { sha256: "f".repeat(64) } };
  await assert.rejects(setup(t, { files: tampered }).preview(), {
    code: "MCP_PACKAGE_INTEGRITY_MISMATCH",
  });
  const gone = release();
  gone[1] = { ...gone[1], filename: "gone-1.0-py3-none-any.whl" };
  await assert.rejects(setup(t, { files: gone }).preview(), {
    code: "MCP_PACKAGE_DOWNLOAD_FAILED",
  });
});

test("a wheel without console scripts has no program; reader errors carry no path", async (t) => {
  await assert.rejects(setup(t, { entryPoints: "" }).preview(), {
    code: "MCP_PACKAGE_NO_PROGRAM",
  });
  const broken = setup(t, {
    reader: () => {
      throw Object.assign(Error(`cannot read /secret/stage/top.whl`), { stderr: "/x" });
    },
  });
  await assert.rejects(broken.preview(), (error) => {
    assert.match(error.code, /^MCP_PACKAGE_/);
    assert.doesNotMatch(error.message, /\//);
    return true;
  });
});

test("an sdist-only release needs a build and names its programs after it", async (t) => {
  const { preview } = setup(t, {
    files: [file("srv_x-1.0.tar.gz", sdistBytes)],
    noWheels: true,
  });
  const result = await preview();
  assert.deepEqual(result.programs, []);
  assert.equal(result.needsScripts, true);
  assert.equal(result.lockText, null);
  assert.deepEqual(result.dependencies, []);
  assert.equal(result.integrity, `sha256:${sha(sdistBytes)}`);
  assert.deepEqual(result.installFile, {
    filename: "srv_x-1.0.tar.gz",
    sha256: sha(sdistBytes),
  });
});

test("a stored lock is checked against the digests in its integrity", () => {
  const integrity = [sha(wheelBytes), sha(sdistBytes)]
    .map((d) => `sha256:${d}`)
    .join(" ");
  const lock = lockOf(sha(wheelBytes));
  const checked = pythonAdapter.checkStored({ lockText: lock, ref, integrity });
  assert.deepEqual(checked.dependencies, [
    { name: "srv-x", version: "1.0", path: "srv-x" },
  ]);
  assert.throws(
    () => pythonAdapter.checkStored({ lockText: lockOf("e".repeat(64)), ref, integrity }),
    { code: "MCP_PACKAGE_INTEGRITY_MISMATCH" },
  );
  for (const bad of [null, "", "sha512-x", `sha256:${sha(wheelBytes)}  `, "sha256:ab"])
    assert.throws(
      () => pythonAdapter.checkStored({ lockText: lock, ref, integrity: bad }),
      {
        code: "MCP_PACKAGE_INTEGRITY_MISMATCH",
      },
    );
});

test("the sync builds only when the owner opted in and the package needs it", async (t) => {
  for (const [allowScripts, needsScripts, wheelsOnly] of [
    [false, false, true],
    [true, false, true],
    [false, true, true],
    [true, true, false],
  ]) {
    const calls = [];
    const directory = path.join(tmp(t), "stage");
    await pythonAdapter.install({
      directory,
      preview: {
        ref,
        allowScripts,
        needsScripts,
        manifestText: "srv-x==1.0\n",
        lockText: lockOf(sha(wheelBytes)),
      },
      toolchain: python,
      registry: pypiIndexRegistry,
      cacheDir: path.join(directory, "..", "cache"),
      execute: async (program, args, options) => {
        calls.push({ args, env: options.env });
        return { stdout: "", stderr: "" };
      },
      environment: {},
    });
    const sync = calls.find((c) => c.args[1] === "sync");
    assert.equal(
      sync.args.includes("--only-binary"),
      wheelsOnly,
      `${allowScripts}/${needsScripts}`,
    );
    assert.equal(sync.env.CC, wheelsOnly ? undefined : "cc");
    assert.equal(sync.env.UV_INDEX_URL, "https://pypi.org/simple");
  }
});

test("installed programs come from the normalised top distribution", (t) => {
  const directory = tmp(t);
  const dist = path.join(directory, "venv", "lib", "python3.14", "site-packages");
  fs.mkdirSync(path.join(dist, "Srv_X-1.0.dist-info"), { recursive: true });
  fs.writeFileSync(
    path.join(dist, "Srv_X-1.0.dist-info", "entry_points.txt"),
    "[console_scripts]\nsrv-x = srv_x:main\n",
  );
  assert.deepEqual(
    pythonAdapter.programsAfterInstall(directory, { ...ref, name: "Srv.X" }),
    [{ name: "srv-x", path: "srv-x" }],
  );
  assert.throws(
    () => pythonAdapter.programsAfterInstall(null, ref),
    (error) => {
      assert.match(error.code, /^MCP_PACKAGE_/);
      return true;
    },
  );
});

test("the toolchain is the managed CPython with its uv", () => {
  assert.equal(pythonAdapter.toolchainKind, "python");
  assert.equal(pythonAdapter.toolchainVersion(python), "3.14.7+uv0.12.21");
  assert.equal(pythonAdapter.manifestText(ref), "srv-x==1.0\n");
});

test("versions come from the JSON API of the configured registry", async () => {
  const urls = [];
  const result = await pythonAdapter.versions("srv-x", {
    registry: { api: "http://127.0.0.1:1", index: "http://127.0.0.1:1/simple" },
    download: async (url) => {
      urls.push(url);
      return Buffer.from(
        JSON.stringify({ info: { version: "1.0" }, releases: { "1.0": release() } }),
      );
    },
  });
  assert.equal(result.latest, "1.0");
  assert.deepEqual(urls, ["http://127.0.0.1:1/pypi/srv-x/json"]);
});
