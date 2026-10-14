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
export function commitInstall(dataDir, { installId, stage, receipt }) {
  writePrivate(path.join(stage, "receipt.json"), receipt);
  const final = installDirectory(dataDir, installId);
  fs.renameSync(stage, final);
  return final;
}
/** The receipt of an install whose lock digest is `digest`, else null. */
export function readInstall(dataDir, installId, digest) {
  try {
    const directory = installDirectory(dataDir, installId);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
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
  const directory = installDirectory(dataDir, receipt.installId);
  const packageDir = path.join(directory, "node_modules", ...receipt.name.split("/"));
  const program = path.join(packageDir, receipt.program.path);
  try {
    const real = fs.realpathSync(program);
    if (
      !real.startsWith(fs.realpathSync(directory) + path.sep) ||
      !fs.statSync(real).isFile()
    )
      throw Error("outside");
  } catch {
    throw packageProblem("MCP_PACKAGE_NO_PROGRAM", 502);
  }
  return { command: node.nodePath, leading: [program] };
}
