import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { stripVTControlCharacters } from "node:util";
import { problem } from "../../lib/storage.js";
import {
  nativeDestination,
  nativeInstallers,
  installNative,
} from "./native-installer.js";

export const updateCommands = {
  codex: ["update"],
  claude: ["update"],
  opencode: ["upgrade", "--method", "curl"],
};
const unmanaged = () => problem(serverMessages.tools.nativeUpdateRequired, 409);

export function planToolUpdate(tool, home, root, detected) {
  if (!Object.hasOwn(nativeInstallers, tool) || !detected?.installed) throw unmanaged();
  const binary = path.join(nativeDestination(home, tool), tool);
  const real = fs.realpathSync(detected.path);
  let nativeReal;
  try {
    nativeReal = fs.realpathSync(binary);
  } catch {}
  if (nativeReal && !nativeReal.startsWith(fs.realpathSync(home) + path.sep))
    throw unmanaged();
  if (nativeReal === real) return { binary, migrate: false };
  const activation = path.join(root, tool);
  if (path.resolve(detected.path) !== path.join(activation, "bin", tool))
    throw unmanaged();
  if (!fs.lstatSync(activation).isSymbolicLink()) throw unmanaged();
  const previous = fs.readlinkSync(activation);
  const packages = fs.realpathSync(path.join(root, ".packages"));
  if (!real.startsWith(packages + path.sep)) throw unmanaged();
  // Existing native destinations must be executable, never overwritten as arbitrary files.
  if (nativeReal) fs.accessSync(binary, fs.constants.X_OK);
  else {
    try {
      fs.lstatSync(binary);
      throw unmanaged();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { binary, migrate: true, activation, previous, install: !nativeReal };
}

export async function updateTool({
  tool,
  plan,
  home,
  root,
  work,
  env,
  signal,
  timeout,
  fetchImpl,
  run,
}) {
  const nativeEnv = {
    ...env,
    HOME: home,
    PATH: `${path.dirname(plan.binary)}${path.delimiter}${env.PATH}`,
  };
  delete nativeEnv.DISABLE_AUTOUPDATER;
  delete nativeEnv.OPENCODE_DISABLE_AUTOUPDATE;
  let version;
  if (plan.install) {
    version = await installNative({
      tool,
      home,
      work,
      env: nativeEnv,
      signal,
      timeout,
      fetchImpl,
      run,
    });
  } else {
    await run(plan.binary, updateCommands[tool], nativeEnv, work, signal, timeout);
    version = stripVTControlCharacters(
      await run(plan.binary, ["--version"], nativeEnv, work, signal, 15000),
    ).trim();
    if (!/\b\d+\.\d+(?:\.\d+)?\b/.test(version) || version.length > 512)
      throw problem(serverMessages.tools.installedVersionCheckFailed, 409);
    version = version.split("\n")[0];
  }
  if (signal.aborted) throw problem(serverMessages.tools.installationAborted, 409);
  if (plan.migrate) {
    // Keep the old npm payload: running CLI processes may still load files from it.
    // Only switch the owned activation after successful native installation/verification.
    const alias = await fsp.mkdtemp(path.join(root, `.native-${tool}-`));
    const link = path.join(work, "activation");
    let published = false;
    try {
      await fsp.mkdir(path.join(alias, "bin"));
      await fsp.symlink(plan.binary, path.join(alias, "bin", tool));
      await fsp.symlink(path.relative(root, alias), link);
      if ((await fsp.readlink(plan.activation)) !== plan.previous)
        throw problem(serverMessages.tools.installationChanged, 409);
      await fsp.rename(link, plan.activation);
      published = true;
    } finally {
      if (!published) await fsp.rm(alias, { recursive: true, force: true });
    }
  }
  return version;
}
