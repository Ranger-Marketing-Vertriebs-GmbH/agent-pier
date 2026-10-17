import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findCommand,
  resolveCommand,
  sanitisedPrefix,
} from "../../server/features/mcp-servers/command-resolution.js";

const files = new Set(["/opt/bin/tool", "/usr/bin/other", "/abs/server"]);
const exists = (file) => files.has(file);

test("bare commands resolve against the given PATH in order", () => {
  assert.equal(
    resolveCommand("tool", { pathEnv: "/nope:/opt/bin:/usr/bin", exists }),
    "/opt/bin/tool",
  );
});
test("absolute commands are kept as entered when they exist", () => {
  assert.equal(resolveCommand("/abs/server", { pathEnv: "", exists }), "/abs/server");
  assert.throws(() => resolveCommand("/abs/missing", { exists }), { status: 400 });
});
test("unresolvable, relative-path and empty commands are rejected", () => {
  for (const command of ["missing", "./tool", "bin/tool", "", "  ", 5, "a\nb"])
    assert.throws(() => resolveCommand(command, { pathEnv: "/opt/bin", exists }), {
      status: 400,
    });
});
test("relative PATH entries are ignored", () => {
  assert.throws(() => resolveCommand("tool", { pathEnv: "opt/bin", exists }), {
    status: 400,
  });
});
test("the tool prefix equals the validated name", () => {
  assert.equal(sanitisedPrefix("My_server-1"), "My_server-1");
  for (const bad of ["a.b", "a".repeat(31), "1abc", "", "a b", "_x", null])
    assert.throws(() => sanitisedPrefix(bad), { status: 400 });
  assert.equal(sanitisedPrefix("a".repeat(30)).length, 30);
});

test("the lookup finds bare commands on the PATH like a save does", () => {
  const options = { pathEnv: "/nope:/opt/bin:/usr/bin", exists };
  assert.equal(findCommand("tool", options), "/opt/bin/tool");
  for (const command of [
    "missing",
    "./tool",
    "bin/tool",
    "",
    "  ",
    5,
    "a\nb",
    "..",
    "a..b",
  ])
    assert.equal(findCommand(command, options), null, String(command));
});

test("the lookup walks absolute paths through listed directory entries", (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-find-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tool = path.join(dir, "tool");
  fs.writeFileSync(tool, "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "data"), "x", { mode: 0o644 });
  fs.mkdirSync(path.join(dir, "sub"));
  // The shared temp folder can hold millions of entries; above the fixture each listing
  // shows only the next path segment, so the walk reads the real disk inside it only.
  const above = new Map();
  for (let child = dir; path.dirname(child) !== child; child = path.dirname(child))
    above.set(path.dirname(child), path.basename(child));
  const options = {
    list: (current) => {
      if (above.has(current)) return [above.get(current)];
      try {
        return fs.readdirSync(current);
      } catch {
        return [];
      }
    },
  };
  assert.equal(findCommand(tool, options), tool);
  assert.equal(findCommand(`  ${dir}//./tool `, options), `${dir}//./tool`);
  assert.equal(findCommand(`${dir}/sub/../tool`, options), null);
  for (const missing of ["data", "sub", "nope", "tool/x"])
    assert.equal(findCommand(path.join(dir, missing), options), null, missing);
});

test("the absolute lookup checks only paths built from listed names", () => {
  const listed = [];
  const tree = { "/": ["opt"], "/opt": ["tool"] };
  const options = {
    exists: (file) => file === "/opt/tool",
    list: (dir) => (listed.push(dir), tree[dir] ?? []),
  };
  assert.equal(findCommand("/opt/tool", options), "/opt/tool");
  assert.equal(findCommand("/opt/other", options), null);
  assert.equal(findCommand("/etc/passwd", options), null);
  assert.deepEqual([...new Set(listed)], ["/", "/opt"]);
});
