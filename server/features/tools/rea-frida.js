import fs from "node:fs";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { reaSources, verifiedDownload } from "./verified-download.js";
import { unpackTarGz } from "./tar-unpack.js";
import { runProcessTree } from "../mcp-packages/child-process-tree.js";

// frida's install script would download its native binding itself; REA's Core installs
// with --ignore-scripts, so AgentPier places the pinned N-API prebuild (rea-manifest.js)
// where frida's `bindings` lookup finds it: node_modules/frida/build/.
const workName = ".frida-work";
const binding = "frida_binding.node";
// The prebuild is one file of about 100 MB.
const limits = { maxExpanded: 512 * 1024 * 1024, maxFiles: 16 };
// Run by the managed Node with the install folder as argv[1]: resolve frida from
// there, import it (which loads the binding) and report whether its API is there.
const loadCheck = [
  'import { createRequire } from "node:module";',
  'import path from "node:path";',
  'import { pathToFileURL } from "node:url";',
  'const require = createRequire(path.join(process.argv[1], "package.json"));',
  'const frida = await import(pathToFileURL(require.resolve("frida")).href);',
  'process.exit(typeof frida.getDeviceManager === "function" ? 0 : 1);',
].join("\n");

// A package problem's code, so the job keeps this wording (install-jobs.js).
const failure = (message) =>
  Object.assign(problem(message, 502), { code: "MCP_PACKAGE_INSTALL_FAILED" });
const diskFull = (error) => ["ENOSPC", "EDQUOT"].includes(error?.code);

/** A real folder, never a link: the binding must land inside the install. */
function realFolder(folder) {
  const stat = fs.lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("not a folder");
}

/**
 * Downloads the pinned frida prebuild `entry` into the npm install `directory`,
 * places its binding and loads frida once with the managed Node (`toolchain.nodePath`)
 * in an empty environment. Any failure ends with `rea.fridaFailed` (a full disk with
 * `rea.diskFull`); the work folder never stays behind.
 */
export async function placeFridaPrebuild({
  directory,
  entry,
  toolchain,
  // McpPackages passes its own runner, which is unset outside tests.
  execute = runProcessTree,
  fetchImpl = fetch,
  signal,
  log,
}) {
  const work = path.join(directory, workName);
  try {
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { mode: 0o700 });
    const archive = path.join(work, "frida.tar.gz");
    await verifiedDownload({
      entry,
      file: archive,
      allow: reaSources,
      fetchImpl,
      signal,
    });
    const unpacked = path.join(work, "unpacked");
    fs.mkdirSync(unpacked, { mode: 0o700 });
    await unpackTarGz(archive, unpacked, "build", signal, limits);
    const source = path.join(unpacked, "build", binding);
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error("no binding");
    const fridaDir = path.join(directory, "node_modules", "frida");
    for (const folder of [
      path.join(directory, "node_modules"),
      fridaDir,
      path.join(fridaDir, "build"),
    ])
      realFolder(folder);
    const target = path.join(fridaDir, "build", binding);
    fs.renameSync(source, target);
    fs.chmodSync(target, 0o755);
    fs.rmSync(work, { recursive: true, force: true });
    await execute(
      toolchain.nodePath,
      ["--input-type=module", "-e", loadCheck, directory],
      { cwd: directory, env: {}, timeout: 60000, maxBuffer: 1024 * 1024, signal },
    );
  } catch (error) {
    // Only catalog texts reach the log: other errors can name paths.
    if (typeof error?.status === "number" && !error.stdout) log?.(error.message);
    throw failure(
      diskFull(error) ? serverMessages.rea.diskFull : serverMessages.rea.fridaFailed,
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
