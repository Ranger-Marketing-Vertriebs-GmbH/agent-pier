import fs from "node:fs";
import path from "node:path";
import { packageProblem } from "./package-errors.js";
import { regularFile } from "./verified-files.js";

// python-build-standalone records its build prefix `/install` in sysconfig. Only a
// whole path component counts: `/usr/bin/install` stays untouched.
const buildPrefix = /(?<=["' =]|-[IL])\/install(?=[/"' ]|$)/gm;

/**
 * Points CPython's recorded sysconfig paths (`INCLUDEPY`, `prefix`, compiler
 * flags) at `finalRoot`, the folder the unpacked `cpython` directory ends up in,
 * so builds of native extensions find the headers. Never the stage path.
 * Returns the rewritten files.
 */
export function relocateSysconfig(cpython, finalRoot, version) {
  const minor = version.split(".").slice(0, 2).join(".");
  const lib = path.join(cpython, "lib", `python${minor}`);
  const names = fs
    .readdirSync(lib)
    .filter((name) => /^_sysconfigdata_.*\.py$/.test(name));
  if (names.length === 0) throw packageProblem("MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE", 503);
  // The value lands inside a single- or double-quoted Python string literal: JSON
  // escapes `"`, `\` and control characters validly for both, `\'` covers `'`.
  const replacement = JSON.stringify(finalRoot).slice(1, -1).replaceAll("'", "\\'");
  const files = names.map((name) => regularFile(path.join(lib, name)));
  for (const file of files) {
    const name = path.basename(file);
    const text = fs.readFileSync(file, "utf8");
    fs.writeFileSync(
      file,
      text.replace(buildPrefix, () => replacement),
    );
    const cached = path.join(lib, "__pycache__");
    for (const entry of fs.existsSync(cached) ? fs.readdirSync(cached) : [])
      if (entry.startsWith(`${path.basename(name, ".py")}.`))
        fs.rmSync(path.join(cached, entry), { force: true });
  }
  return files;
}
