import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { relocateSysconfig } from "../../server/features/mcp-packages/cpython-relocation.js";

// The build writes one of these literal styles (pprint uses single quotes).
const styles = {
  double:
    'build_time_vars = {"INCLUDEPY": "/install/include/python3.14", ' +
    "\"CONFIG_ARGS\": \"'--prefix=/install' 'INSTALL=/usr/bin/install -c'\", " +
    '"X": "/installer/bin"}\n',
  pprint:
    "build_time_vars = {'INCLUDEPY': '/install/include/python3.14',\n" +
    " 'CONFIG_ARGS': \"'--prefix=/install' 'INSTALL=/usr/bin/install -c'\",\n" +
    " 'X': '/installer/bin'}\n",
};
function python3Works() {
  try {
    execFileSync("python3", ["-I", "-c", "pass"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function cpython(t, text = styles.double) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cpython-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lib = path.join(root, "lib", "python3.14");
  fs.mkdirSync(path.join(lib, "__pycache__"), { recursive: true });
  const data = path.join(lib, "_sysconfigdata__linux_x86_64-linux-gnu.py");
  fs.writeFileSync(data, text);
  const pyc = path.join(
    lib,
    "__pycache__",
    "_sysconfigdata__linux_x86_64-linux-gnu.cpython-314.pyc",
  );
  fs.writeFileSync(pyc, "stale");
  return { root, data, pyc };
}

for (const [style, text] of Object.entries(styles))
  test(`${style} sysconfig paths move to a final folder with quotes and spaces`, (t) => {
    if (!python3Works()) return t.skip("python3 is not available");
    const c = cpython(t, text);
    const final = `/data/Application Support/o'brien/"odd"\\name/cpython`;
    const rewritten = relocateSysconfig(c.root, final, "3.14.7");
    const relocated = fs.readFileSync(c.data, "utf8");
    assert.equal(fs.existsSync(c.pyc), false);
    const vars = JSON.parse(
      execFileSync("python3", [
        "-I",
        "-c",
        `import json\n${relocated}\nprint(json.dumps(build_time_vars))`,
      ]),
    );
    assert.deepEqual(vars, {
      INCLUDEPY: `${final}/include/python3.14`,
      CONFIG_ARGS: `'--prefix=${final}' 'INSTALL=/usr/bin/install -c'`,
      X: "/installer/bin",
    });
    assert.deepEqual(rewritten, [c.data]);
  });

test("a CPython without sysconfig data is refused", (t) => {
  const c = cpython(t);
  fs.rmSync(c.data);
  assert.throws(() => relocateSysconfig(c.root, "/x", "3.14.7"), {
    code: "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE",
  });
});
