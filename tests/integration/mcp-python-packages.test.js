import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  createPython,
  pinnedSetuptools,
  pypiRef,
  pythonPackageService,
} from "../helpers/mcp-python-service.js";
import { mcpServerConfig } from "../../server/features/assistants/openclaw-config/mcp-servers.js";
import { gatewayPath } from "../../server/features/assistants/runtime-config.js";
import { toolchainRoot } from "../../server/features/mcp-packages/toolchains.js";

// Real uv 0.12.21 and CPython 3.14.7 (the managed toolchain, downloaded once into
// $TMPDIR/agentpier-test-toolchains) against a local index; CI sets the variable.
const skip = process.env.AGENTPIER_MCP_PYTHON_TESTS !== "1";
const server = {
  name: "srv-x",
  version: "1.0",
  script: "srv-x",
  requires: ["helper-x==2.0"],
};
const helper = { name: "helper-x", version: "2.0", script: "helper-tool" };
const installs = (s) => path.join(s.dataDir, "mcp-packages", "installs");
const uvRuns = (s, command) =>
  s.calls.filter((args) => args[0] === command || args.slice(0, 2).join(" ") === command);
const syncs = (s) => s.calls.filter((args) => args[0] === "pip" && args[1] === "sync");

test(
  "a wheel-only package installs from the local index into a relocatable venv and starts",
  { skip },
  async (t) => {
    const s = await pythonPackageService(t, [server, helper]);
    const { preview, server: ready } = await createPython(s, "srv-x");
    assert.deepEqual(preview.programs, ["srv-x"]);
    assert.equal(preview.needsScripts, false);
    assert.equal(preview.dependencyCount, 2);
    assert.match(preview.integrity, /^sha256:[0-9a-f]{64}$/);
    assert.equal(ready.source.status, "ready");
    assert.equal(ready.source.leadingArgs, 0);
    assert.match(
      ready.command,
      /mcp-packages\/installs\/[0-9a-f-]{36}\/venv\/bin\/srv-x$/,
    );
    // uv resolved and downloaded from the fixture: the index, never pypi.org.
    for (const url of [
      "/simple/srv-x/",
      "/simple/helper-x/",
      "/files/srv_x-1.0-py3-none-any.whl",
      "/files/helper_x-2.0-py3-none-any.whl",
    ])
      assert.ok(s.index.requests.includes(url), url);
    // Wheels only: the sync refuses any build without the opt-in.
    assert.equal(syncs(s).length, 1);
    assert.ok(syncs(s)[0].join(" ").includes("--only-binary :all:"));
    const row = s.servers.packages.get(ready.id);
    assert.equal(path.dirname(row.toolchainDir), toolchainRoot(s.dataDir));
    assert.match(path.basename(row.toolchainDir), /^python-3\.14\.7\+\d+-uv0\.12\.21-/);
    assert.doesNotMatch(row.lock, /pypi\.org|127\.0\.0\.1|\.stage-|#/);
    const receipt = JSON.parse(
      fs.readFileSync(path.join(installs(s), row.installId, "receipt.json"), "utf8"),
    );
    assert.deepEqual(receipt.toolchain.kind, "python");
    assert.equal(receipt.toolchain.version, "3.14.7+uv0.12.21");
    assert.equal(receipt.needsScripts, false);
    // The spawn as the agents get it, after the stage → final rename: the venv's
    // relocatable wrapper runs `dirname` and `realpath` from the PATH, and the Gateway's
    // PATH always ends with /usr/bin:/bin (the CLIs inherit the service's PATH).
    const definition = s.servers.definitions().find((d) => d.id === ready.id);
    const spawn = mcpServerConfig(definition, s.servers.secrets(ready.id));
    assert.equal(spawn.command, ready.command);
    const gateway = { PATH: gatewayPath("/opt/node/bin/node") };
    assert.equal(gateway.PATH, "/opt/node/bin:/usr/bin:/bin");
    for (const env of [{ ...gateway, ...spawn.env }, { PATH: "/usr/bin:/bin" }])
      assert.equal(
        execFileSync(spawn.command, spawn.args, { env }).toString().trim(),
        "ok",
      );
    assert.doesNotMatch(fs.readFileSync(ready.command, "utf8"), /\.stage-/);
    // Independent of the uv cache (UV_LINK_MODE=copy): no file has a second name.
    const venv = path.dirname(path.dirname(ready.command));
    for (const name of fs.readdirSync(venv, { recursive: true })) {
      const stat = fs.lstatSync(path.join(venv, String(name)));
      if (stat.isFile()) assert.equal(stat.nlink, 1, String(name));
    }
  },
);

test("only the top distribution's scripts are programs", { skip }, async (t) => {
  const s = await pythonPackageService(t, [server, helper]);
  const preview = await s.packages.preview(pypiRef("srv-x"));
  assert.deepEqual(preview.programs, ["srv-x"]);
});

test(
  "an sdist-only package needs the opt-in and is refused without it",
  { skip },
  async (t) => {
    const s = await pythonPackageService(t, [
      { name: "old-x", version: "1.0", sdistOnly: true },
    ]);
    const preview = await s.packages.preview(pypiRef("old-x"));
    assert.equal(preview.needsScripts, true);
    assert.deepEqual(preview.programs, []);
    assert.ok(s.index.requests.includes("/simple/old-x/"));
    await assert.rejects(
      s.packages.createServer(
        { name: "old", transport: "stdio", source: pypiRef("old-x") },
        { previewId: preview.previewId },
      ),
      { code: "MCP_PACKAGE_NEEDS_SCRIPTS" },
    );
    assert.deepEqual(fs.existsSync(installs(s)) ? fs.readdirSync(installs(s)) : [], []);
  },
);

test(
  "an update shows the lock diff; reinstall installs the stored lock without resolving",
  { skip },
  async (t) => {
    const s = await pythonPackageService(t, [
      server,
      helper,
      { ...helper, version: "3.0" },
      { ...server, version: "2.0", requires: ["helper-x==3.0"] },
    ]);
    const { server: ready } = await createPython(s, "srv-x");
    const update = await s.packages.preview({
      ...pypiRef("srv-x", "2.0"),
      serverId: ready.id,
    });
    assert.deepEqual(
      update.diff.changed.map((c) => [c.name, c.from, c.to]),
      [
        ["helper-x", "2.0", "3.0"],
        ["srv-x", "1.0", "2.0"],
      ],
    );
    fs.rmSync(installs(s), { recursive: true });
    assert.equal(s.servers.get(ready.id).source.status, "missing");
    const compiles = uvRuns(s, "pip compile").length;
    s.index.requests.length = 0;
    s.packages.reinstall(ready.id);
    await s.packages.jobs.idle();
    const after = s.servers.get(ready.id);
    assert.equal(after.source.status, "ready");
    assert.equal(after.source.version, "1.0");
    assert.equal(uvRuns(s, "pip compile").length, compiles);
    assert.ok(!s.index.requests.some((url) => url.startsWith("/pypi/")));
    assert.equal(
      execFileSync(after.command, { env: { PATH: "/usr/bin:/bin" } })
        .toString()
        .trim(),
      "ok",
    );
    // The update itself installs the new lock.
    const next = await s.packages.preview({
      ...pypiRef("srv-x", "2.0"),
      serverId: ready.id,
    });
    await s.packages.updatePackage(ready.id, {
      version: "2.0",
      previewId: next.previewId,
    });
    await s.packages.jobs.idle();
    const updated = s.servers.get(ready.id);
    assert.equal(updated.source.status, "ready");
    assert.equal(updated.source.version, "2.0");
    assert.match(s.servers.packages.get(ready.id).lock, /^helper-x==3\.0 /m);
  },
);

test(
  "with the opt-in an sdist with a C extension builds with cc and starts",
  { skip },
  async (t) => {
    const s = await pythonPackageService(t, [
      { name: "old-c", version: "1.0", script: "old-c", sdist: "c-extension" },
      { name: "setuptools", version: "84.0.0", file: await pinnedSetuptools() },
    ]);
    // Without the opt-in: nothing builds, the install is refused.
    const refused = await s.packages.preview(pypiRef("old-c"));
    assert.equal(refused.needsScripts, true);
    await assert.rejects(
      s.packages.createServer(
        { name: "old", transport: "stdio", source: pypiRef("old-c") },
        { previewId: refused.previewId },
      ),
      { code: "MCP_PACKAGE_NEEDS_SCRIPTS" },
    );
    assert.ok(!s.index.requests.includes("/files/setuptools-84.0.0-py3-none-any.whl"));
    // With the opt-in: the build backend comes from the index (outside the lock).
    const { preview, server: ready } = await createPython(s, "old-c", {
      allowScripts: true,
    });
    assert.equal(preview.needsScripts, true);
    assert.deepEqual(preview.programs, []);
    assert.equal(ready.source.status, "ready", s.packages.jobs.get(ready.id)?.log);
    assert.equal(ready.source.program, "old-c");
    assert.ok(s.index.requests.includes("/files/setuptools-84.0.0-py3-none-any.whl"));
    assert.doesNotMatch(s.servers.packages.get(ready.id).lock, /setuptools/);
    assert.ok(
      syncs(s)
        .at(-1)
        .every((arg) => arg !== "--only-binary"),
    );
    assert.equal(
      execFileSync(ready.command, { env: { PATH: "/usr/bin:/bin" } })
        .toString()
        .trim(),
      "built",
    );
  },
);

test(
  "a constraint narrows the resolve and stays for reinstall and update",
  { skip },
  async (t) => {
    const s = await pythonPackageService(t, [
      { name: "srv-y", version: "1.0", script: "srv-y", requires: ["helper-x>=2"] },
      { name: "srv-y", version: "1.1", script: "srv-y", requires: ["helper-x>=2"] },
      helper,
      { ...helper, version: "3.0" },
    ]);
    const version = (preview, name) =>
      preview.dependencies.find((d) => d.name === name)?.version;
    const free = await s.packages.preview(pypiRef("srv-y"));
    assert.equal(version(free, "helper-x"), "3.0");
    assert.deepEqual(free.constraints, []);
    const { preview, server: ready } = await createPython(s, "srv-y", {
      constraints: ["Helper_X < 3"],
    });
    assert.deepEqual(preview.constraints, ["helper-x<3"]);
    assert.equal(version(preview, "helper-x"), "2.0");
    assert.equal(ready.source.status, "ready", s.packages.jobs.get(ready.id)?.log);
    assert.deepEqual(ready.source.constraints, ["helper-x<3"]);
    const row = s.servers.packages.get(ready.id);
    assert.match(row.lock, /^helper-x==2\.0 /m);
    // The constraints file never reaches the lock (no annotations, no header).
    assert.doesNotMatch(row.lock, /constraints|\.uv-work|#/);
    // Reinstall: the frozen lock, no resolve, still helper-x 2.0.
    fs.rmSync(installs(s), { recursive: true });
    const compiles = uvRuns(s, "pip compile").length;
    s.packages.reinstall(ready.id);
    await s.packages.jobs.idle();
    assert.equal(s.servers.get(ready.id).source.status, "ready");
    assert.equal(uvRuns(s, "pip compile").length, compiles);
    assert.equal(s.servers.packages.get(ready.id).lock, row.lock);
    // An update keeps the constraint: only the top package changes.
    const update = await s.packages.preview({
      ...pypiRef("srv-y", "1.1"),
      serverId: ready.id,
    });
    assert.deepEqual(update.constraints, ["helper-x<3"]);
    assert.deepEqual(
      update.diff.changed.map((c) => c.name),
      ["srv-y"],
    );
    await s.packages.updatePackage(ready.id, {
      version: "1.1",
      previewId: update.previewId,
    });
    await s.packages.jobs.idle();
    const updated = s.servers.get(ready.id);
    assert.equal(updated.source.version, "1.1");
    assert.deepEqual(updated.source.constraints, ["helper-x<3"]);
    assert.match(s.servers.packages.get(ready.id).lock, /^helper-x==2\.0 /m);
    await assert.rejects(
      s.packages.preview({
        ...pypiRef("srv-y"),
        constraints: ["helper-x @ http://e/x.whl"],
      }),
      { code: "MCP_PACKAGE_INVALID" },
    );
  },
);

test(
  "an sdist with two scripts waits for the program choice and then starts",
  { skip },
  async (t) => {
    const s = await pythonPackageService(t, [
      {
        name: "two-c",
        version: "1.0",
        scripts: ["two-a", "two-b"],
        sdist: "c-extension",
      },
      { name: "setuptools", version: "84.0.0", file: await pinnedSetuptools() },
    ]);
    const { server } = await createPython(s, "two-c", { allowScripts: true });
    assert.equal(server.source.status, "choosing", s.packages.jobs.get(server.id)?.log);
    assert.deepEqual(s.packages.status(server.id).programs, ["two-a", "two-b"]);
    const runs = s.calls.length;
    s.packages.chooseProgram(server.id, "two-b");
    await s.packages.jobs.idle();
    const ready = s.servers.get(server.id);
    assert.equal(ready.source.status, "ready", s.packages.jobs.get(server.id)?.log);
    assert.equal(ready.source.program, "two-b");
    assert.equal(s.calls.length, runs, "no uv run after the choice");
    assert.match(ready.command, /\/venv\/bin\/two-b$/);
    assert.equal(
      execFileSync(ready.command, { env: { PATH: "/usr/bin:/bin" } })
        .toString()
        .trim(),
      "built",
    );
  },
);
