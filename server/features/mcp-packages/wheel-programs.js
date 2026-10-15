import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizePypiName } from "./package-spec.js";

const executeFile = promisify(execFile);
const scriptName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const maxEntryPoints = 1024 * 1024;

/** Console scripts of an entry_points.txt text; names are validated like npm programs. */
export function consoleScripts(text) {
  const programs = [];
  let section = "";
  for (const raw of typeof text === "string" ? text.split(/\r?\n/) : []) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) section = line;
    else if (section === "[console_scripts]" && line.includes("=")) {
      const name = line.split("=")[0].trim();
      if (scriptName.test(name) && !programs.some((program) => program.name === name))
        programs.push({ name, path: name });
    }
  }
  return programs;
}

// Reads one member of a zip; never extracts or imports anything from the wheel.
const reader = [
  "import sys, zipfile",
  "z = zipfile.ZipFile(sys.argv[1])",
  "infos = [i for i in z.infolist() if i.filename.count('/') == 1 and i.filename.endswith('.dist-info/entry_points.txt')]",
  `ok = len(infos) == 1 and infos[0].file_size <= ${maxEntryPoints}`,
  "sys.stdout.write(z.read(infos[0]).decode('utf-8') if ok else '')",
].join("\n");

export async function wheelEntryPoints({ python, wheelFile, execute = executeFile }) {
  const { stdout } = await execute(python.pythonPath, ["-I", "-c", reader, wheelFile], {
    env: { PATH: "/usr/bin:/bin" },
    timeout: 30000,
    maxBuffer: 2 * maxEntryPoints,
  });
  return stdout;
}

const regularText = (file) => {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > maxEntryPoints) return "";
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};
const listing = (directory) => {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
};

/** A folder reached without a link. */
const realFolder = (dir) => {
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The entry points of the installed distribution `name`: exactly one `.dist-info`
 * folder, found in sorted order and never through a link. Two copies (a leftover of
 * another version) or a linked one leave the program unknown.
 */
export function installedEntryPoints(venvDir, name) {
  const lib = path.join(venvDir, "lib");
  const found = [];
  for (const version of listing(lib).sort()) {
    const site = path.join(lib, version, "site-packages");
    for (const entry of listing(site).sort()) {
      if (!entry.endsWith(".dist-info")) continue;
      const dist = entry.slice(0, -".dist-info".length).replace(/-[^-]+$/, "");
      if (normalizePypiName(dist) === name) found.push(path.join(site, entry));
    }
  }
  return found.length === 1 && realFolder(found[0])
    ? regularText(path.join(found[0], "entry_points.txt"))
    : "";
}
