import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { packageProblem } from "./package-errors.js";
import { privateFolder, regularFile } from "./verified-files.js";

const idPattern = /^[0-9a-f-]{36}$/;
export const packageRoot = (dataDir) => privateFolder(path.join(dataDir, "mcp-packages"));
const installs = (dataDir) => privateFolder(path.join(packageRoot(dataDir), "installs"));
export function installDirectory(dataDir, installId) {
  if (!idPattern.test(installId)) throw packageProblem("MCP_PACKAGE_INSTALL_FAILED", 500);
  return path.join(dataDir, "mcp-packages", "installs", installId);
}
export function stageInstall(dataDir) {
  const installId = randomUUID();
  return {
    installId,
    stage: privateFolder(path.join(installs(dataDir), `.stage-${installId}`)),
  };
}
/** The install directory when it is a real folder directly inside the installs root. */
function verifiedInstall(dataDir, installId) {
  const directory = installDirectory(dataDir, installId);
  const root = fs.realpathSync(installs(dataDir));
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(directory) !== path.join(root, installId)
  )
    throw Error("untrusted install");
  return directory;
}
export function commitInstall(dataDir, { installId, stage, receipt }) {
  if (stage !== path.join(installs(dataDir), `.stage-${installId}`))
    throw packageProblem("MCP_PACKAGE_INSTALL_FAILED", 500);
  writePrivate(path.join(stage, "receipt.json"), receipt);
  const final = installDirectory(dataDir, installId);
  fs.renameSync(stage, final);
  return final;
}
/** Replaces the receipt of a committed install (the program chosen after a build). */
export function rewriteReceipt(dataDir, installId, receipt) {
  writePrivate(path.join(verifiedInstall(dataDir, installId), "receipt.json"), receipt);
}
/** The receipt of an install whose lock digest is `digest`, else null. */
export function readInstall(dataDir, installId, digest) {
  try {
    const directory = verifiedInstall(dataDir, installId);
    const file = regularFile(
      path.join(directory, "receipt.json"),
      "MCP_PACKAGE_INSTALL_FAILED",
    );
    const receipt = readJSON(file, null);
    return receipt?.lockDigest === digest ? receipt : null;
  } catch {
    return null;
  }
}
/**
 * The receipt of a `choosing` record whose built install, with its program list, is
 * still there; else null (a record not choosing, or its install gone or replaced).
 */
export function choosingReceipt(dataDir, row) {
  if (row?.status !== "choosing" || !row.installId) return null;
  const receipt = readInstall(dataDir, row.installId, row.lockDigest);
  return Array.isArray(receipt?.programs) ? receipt : null;
}
export function pruneInstalls(dataDir, keep) {
  const root = path.join(dataDir, "mcp-packages", "installs");
  let names;
  try {
    // Never through a link: a moved or replaced folder is left alone.
    for (const dir of [path.dirname(root), root])
      if (!fs.lstatSync(dir).isDirectory()) return;
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const id = name.replace(/^\.stage-/, "");
    if (!keep.has(id)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
}
/** The managed Node plus the program's absolute path, contained in the install. */
export function npmCommand(dataDir, receipt, node) {
  try {
    const directory = verifiedInstall(dataDir, receipt.installId);
    const packageDir = path.join(directory, "node_modules", ...receipt.name.split("/"));
    const program = path.join(packageDir, receipt.program.path);
    const real = fs.realpathSync(program);
    if (
      !real.startsWith(fs.realpathSync(directory) + path.sep) ||
      !fs.statSync(real).isFile()
    )
      throw Error("outside");
    return { command: node.nodePath, leading: [program] };
  } catch {
    throw packageProblem("MCP_PACKAGE_NO_PROGRAM", 502);
  }
}
/** The venv's console script of the program, contained in the install. */
export function pythonCommand(dataDir, receipt) {
  try {
    const directory = verifiedInstall(dataDir, receipt.installId);
    const bin = path.join(directory, "venv", "bin");
    const file = receipt.program.path;
    if (typeof file !== "string" || !file || file.includes("/") || file.includes("\\"))
      throw Error("outside");
    const program = path.join(bin, file);
    if (path.dirname(program) !== bin || file === "." || file === "..")
      throw Error("outside");
    const stat = fs.lstatSync(program);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error("not a script");
    const realBin = path.join(fs.realpathSync(directory), "venv", "bin");
    if (fs.realpathSync(program) !== path.join(realBin, file)) throw Error("outside");
    return { command: program, leading: [] };
  } catch {
    throw packageProblem("MCP_PACKAGE_NO_PROGRAM", 502);
  }
}
