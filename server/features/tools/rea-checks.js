import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { problem } from "../../lib/storage.js";

// Checks an unpacked REA component (AGENTPIER-104) before its link is switched: the
// pinned version, the files REA needs and, where it applies, its native libraries.
const bad = (message) => problem(message, 409);
const diskFull = (error) => ["ENOSPC", "EDQUOT"].includes(error?.code);

/** The real path of `relative` inside `directory`, or null when it leaves it. */
export function insideReal(directory, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative)) return null;
  try {
    const base = fs.realpathSync(directory);
    const target = fs.realpathSync(path.join(base, relative));
    return target.startsWith(base + path.sep) ? target : null;
  } catch {
    return null;
  }
}

// Downloaded by AgentPier, not a browser, so Gatekeeper never set it; cleared anyway so
// a copy from elsewhere cannot stop Ghidra's or Java's native code.
async function clearQuarantine({ directory, platform, run, env, signal }) {
  if (platform !== "darwin") return;
  await run("/usr/bin/xattr", ["-cr", directory], env, directory, signal, 120000).catch(
    () => {},
  );
}

/**
 * Ghidra: `application.properties` names the pinned version, the platform's native
 * decompiler is a regular executable file inside the install folder and, on Linux,
 * every library it links resolves.
 */
export async function checkGhidra({
  directory,
  entry,
  version,
  platform,
  run,
  env,
  signal,
}) {
  await clearQuarantine({ directory, platform, run, env, signal });
  const home = insideReal(directory, entry.installDir);
  if (!home) throw bad(serverMessages.rea.layoutInvalid("Ghidra"));
  const properties = await fsp
    .readFile(path.join(home, "Ghidra", "application.properties"), "utf8")
    .catch(() => null);
  if (properties === null) throw bad(serverMessages.rea.layoutInvalid("Ghidra"));
  const found = properties.match(/^application\.version=(.*)$/m)?.[1]?.trim();
  if (found !== version) throw bad(serverMessages.rea.ghidraVersionMismatch(version));
  // A link inside the install folder is followed; its target must stay inside.
  const decompiler = insideReal(home, entry.decompiler);
  const stat = decompiler && (await fsp.stat(decompiler).catch(() => null));
  const executable =
    stat?.isFile() &&
    (await fsp.access(decompiler, fs.constants.X_OK).then(
      () => true,
      () => false,
    ));
  if (!executable) throw bad(serverMessages.rea.ghidraDecompilerMissing);
  if (platform !== "linux") return;
  const output = await run("ldd", [decompiler], env, home, signal, 60000).catch(
    (error) => {
      if (diskFull(error) || signal?.aborted) throw error;
      return "";
    },
  );
  const missing = [
    ...new Set(
      [...output.matchAll(/^\s*(\S+)\s+=>\s+not found/gm)].map((match) => match[1]),
    ),
  ];
  if (missing.length)
    throw bad(serverMessages.rea.ghidraMissingLibraries(missing.join(", ")));
}

/** The JDK: `<home>/bin/java -version` starts and reports the pinned version. */
export async function checkJdk({
  directory,
  entry,
  version,
  platform,
  run,
  env,
  signal,
}) {
  await clearQuarantine({ directory, platform, run, env, signal });
  const home = insideReal(directory, entry.home);
  if (!home) throw bad(serverMessages.rea.layoutInvalid("JDK"));
  const java = path.join(home, "bin", "java");
  const output = await run(java, ["-version"], env, home, signal, 60000).catch(
    (error) => {
      if (diskFull(error)) throw error;
      if (signal?.aborted) throw error;
      throw bad(serverMessages.rea.jdkNotStarting);
    },
  );
  // The exact version: 21.0.13+9 must not match 21.0.13+91.
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`(?:^|[^0-9.])${escaped}(?![0-9])`).test(output))
    throw bad(serverMessages.rea.jdkVersionMismatch(version));
}
