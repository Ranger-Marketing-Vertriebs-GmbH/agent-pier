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
export function pruneInstalls(dataDir, keep) {
  let names;
  try {
    names = fs.readdirSync(path.join(dataDir, "mcp-packages", "installs"));
  } catch {
    return;
  }
  for (const name of names) {
    const id = name.replace(/^\.stage-/, "");
    if (!keep.has(id))
      fs.rmSync(path.join(dataDir, "mcp-packages", "installs", name), {
        recursive: true,
        force: true,
      });
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
