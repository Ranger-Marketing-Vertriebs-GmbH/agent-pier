import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  interpreters,
  stdioGrants,
} from "../../server/features/mcp-servers/cli-grants.js";

const heads = {
  "/opt/tools/server.js": "#!/usr/bin/env -S node --no-warnings\nconsole.log(1)\n",
  "/opt/tools/run.sh": "#!/bin/sh -e\necho\n",
  "/opt/tools/bin": "\u007fELF\u0002",
};
const options = {
  pathEnv: "/fake/bin",
  exists: (file) => file === "/fake/bin/node",
  readHead: (file) => {
    if (!Object.hasOwn(heads, file))
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return heads[file];
  },
  realpath: (file) => (file === "/opt/link" ? "/opt/tools/server.js" : file),
  executable: () => true,
};

test("interpreters come from the #! line; env names are resolved on PATH", () => {
  assert.deepEqual(interpreters("/opt/tools/server.js", options), [
    "/usr/bin/env",
    "/fake/bin/node",
  ]);
  assert.deepEqual(interpreters("/opt/tools/run.sh", options), ["/bin/sh"]);
  assert.deepEqual(interpreters("/opt/tools/bin", options), []);
  assert.deepEqual(interpreters("/missing", options), []);
});

test("a stdio server's command, link target, interpreter and cwd are granted; remote ones nothing", () => {
  const grants = stdioGrants(
    [
      { transport: "stdio", command: "/opt/link", cwd: "/work" },
      { transport: "stdio", command: "/opt/tools/run.sh", cwd: null },
      { transport: "stdio", command: "/opt/tools/bin", cwd: null },
      { transport: "http", url: "https://mcp.example.test/mcp" },
    ],
    options,
  );
  assert.deepEqual(grants, [
    { access: "read", path: "/opt/link" },
    { access: "read", path: "/opt/tools/server.js" },
    { access: "read", path: "/usr/bin/env" },
    { access: "read", path: "/fake/bin/node" },
    { access: "allow", path: "/work" },
    { access: "read", path: "/opt/tools/run.sh" },
    { access: "read", path: "/bin/sh" },
    { access: "read", path: "/opt/tools/bin" },
  ]);
});

const tempTree = (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cli-grants-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const dataDir = path.join(home, ".agentpier");
  const project = path.join(home, "project");
  for (const dir of [dataDir, path.join(dataDir, "sub"), project])
    fs.mkdirSync(dir, { recursive: true });
  return { root, home, dataDir, project };
};

test("a cwd that would open up /, HOME, its parents or the data directory gets no grant", (t) => {
  const { root, home, dataDir, project } = tempTree(t);
  const warnings = [];
  const cwds = ["/", home, root, dataDir, path.join(dataDir, "sub"), `${home}/./`];
  const grants = stdioGrants(
    [...cwds, project].map((cwd) => ({
      transport: "stdio",
      command: "/fake/missing/server",
      cwd,
    })),
    { home, dataDir, warn: (line) => warnings.push(line) },
  );
  assert.deepEqual(
    grants.filter((grant) => grant.access === "allow"),
    [{ access: "allow", path: project }],
  );
  assert.equal(warnings.length, cwds.length);
  for (const line of warnings) assert.doesNotMatch(line, /\/|cli-grants/);
});

test(
  "a FIFO as the command is never read or granted, so a session start cannot hang",
  { timeout: 5000 },
  (t) => {
    const { root } = tempTree(t);
    const fifo = path.join(root, "server.fifo");
    execFileSync("mkfifo", [fifo]);
    assert.deepEqual(interpreters(fifo), []);
    assert.deepEqual(stdioGrants([{ transport: "stdio", command: fifo }]), []);
  },
);

const script = (file, firstLine, mode = 0o755) => {
  fs.writeFileSync(file, `${firstLine}\necho\n`, { mode });
  fs.chmodSync(file, mode);
  return file;
};
const readPaths = (grants) =>
  grants.filter((grant) => grant.access === "read").map((grant) => grant.path);

test("a valid interpreter of a bound script is granted", (t) => {
  const { home, dataDir, project } = tempTree(t);
  const interpreter = script(path.join(project, "interp"), "\u007fELF");
  const server = script(path.join(project, "server.sh"), `#!${interpreter} -e`);
  const grants = stdioGrants([{ transport: "stdio", command: server }], {
    home,
    dataDir,
  });
  assert.deepEqual(readPaths(grants), [server, interpreter]);
});

test("a #! line naming a directory such as HOME grants no read on it", (t) => {
  const { home, dataDir, project } = tempTree(t);
  const server = script(path.join(project, "server.sh"), `#!${home}`);
  const grants = stdioGrants([{ transport: "stdio", command: server }], {
    home,
    dataDir,
  });
  assert.deepEqual(readPaths(grants), [server]);
});

test("a command linked to a non-executable file such as a key grants nothing", (t) => {
  const { home, dataDir, project } = tempTree(t);
  const ssh = path.join(home, ".ssh");
  fs.mkdirSync(ssh);
  const key = path.join(ssh, "id_ed25519");
  fs.writeFileSync(key, "PRIVATE", { mode: 0o600 });
  const link = path.join(project, "linked");
  fs.symlinkSync(key, link);
  const grants = stdioGrants([{ transport: "stdio", command: link }], { home, dataDir });
  assert.deepEqual(grants, []);
});

test("an interpreter or link target inside the data directory is never granted", (t) => {
  const { home, dataDir, project } = tempTree(t);
  const inside = script(path.join(dataDir, "sub", "tool"), "\u007fELF");
  const server = script(path.join(project, "server.sh"), `#!${inside}`);
  const link = path.join(project, "linked");
  fs.symlinkSync(inside, link);
  const grants = stdioGrants(
    [
      { transport: "stdio", command: server },
      { transport: "stdio", command: link },
    ],
    { home, dataDir },
  );
  assert.deepEqual(readPaths(grants), [server]);
});
