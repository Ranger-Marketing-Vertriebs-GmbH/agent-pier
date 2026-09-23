import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeGrants } from "./sandbox-grants.js";
import { readSandboxProfiles } from "./nono-profiles.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

/**
 * The AgentPier installation root, the directory holding `server/` and
 * `vendor/`. Derived from this module's own location, never from
 * configuration, so a relocated or reinstalled copy stays correct.
 */
export const INSTALLATION_ROOT = path.resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);
/**
 * Several integrations start a script of ours inside the sandboxed CLI, and
 * those scripts import across `server/`, `vendor/` and their npm dependencies,
 * so a per-file grant on the entry script alone would die at the first
 * import. These three subtrees are the only ones granted: the installation
 * root itself is never granted, because a checkout's default data directory
 * (`<root>/.data`) sits right beside them, and nono has no flag to carve a
 * subtree back out of a broader grant.
 */
export const INSTALLATION_GRANTS = ["server", "vendor", "node_modules"].map((dir) =>
  path.join(INSTALLATION_ROOT, dir),
);
/**
 * Node resolves the module type of a script it runs by walking up from the
 * script to the nearest `package.json`. Nothing under `server/` carries one, so
 * that walk reaches the installation root, and a denied read there is fatal
 * rather than skipped: node reports `ERR_INVALID_PACKAGE_CONFIG` ("Cannot read
 * package config … permission denied", at `node:internal/modules/run_main`) and
 * the script never starts. `"type": "module"` lives in that file, so every hook
 * and MCP server we run inside a sandboxed CLI needs it readable. It is granted
 * as a single file, never as the root directory, so `<root>/.data` beside it
 * stays unreachable. `vendor/agentbus/` carries its own `package.json` inside an
 * already granted subtree and ends the walk before the root.
 */
export const INSTALLATION_FILE_GRANTS = [path.join(INSTALLATION_ROOT, "package.json")];
/**
 * nono keeps directory grants and single-file grants apart: `--read <DIR>` is
 * recursive and refuses a file ("CLI path '…' is not a directory. Use
 * --allow-file for single files."), so every grant is classified before it
 * becomes a flag.
 */
const directoryFlags = { allow: "--allow", read: "--read", write: "--write" };
const fileFlags = {
  allow: "--allow-file",
  read: "--read-file",
  write: "--write-file",
};
/**
 * A path that does not exist is treated as a single file: nono accepts a
 * missing file grant and skips a missing directory grant with a warning. Every
 * adapter creates its paths before the nono adapter composes the launch, so
 * this only decides the degenerate case.
 */
const existingDirectory = (target) => {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
};
const compare = (a, b) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : a.access < b.access ? -1 : 1;
function grantFlag(grant, isDirectory) {
  // Connecting to or binding an AF_UNIX socket is a capability of its own in
  // nono: file access to the socket path, or its directory, confers neither.
  if (grant.access === "socket") return "--allow-unix-socket";
  if (grant.access === "socket-dir-bind") return "--allow-unix-socket-dir-bind";
  const flag = (isDirectory(grant.path) ? directoryFlags : fileFlags)[grant.access];
  // An unknown access kind means an adapter declared a capability this composer
  // cannot express. Dropping it would silently deny that integration at runtime.
  if (!flag) throw new Error(`Unknown sandbox grant access: ${grant.access}`);
  return flag;
}
/**
 * Grants are merged, then sorted by path and access, so a launch description is
 * stable across restarts and never depends on the order of the adapter chain.
 */
export function grantArguments(grants, { isDirectory = existingDirectory } = {}) {
  return mergeGrants(grants)
    .sort(compare)
    .flatMap((grant) => [grantFlag(grant, isDirectory), grant.path]);
}
/**
 * `nono wrap` applies the nono sandbox and execs into the CLI, so the process
 * group, the stop path and native observation keep seeing the CLI itself.
 * Everything after `--` belongs to the CLI, which is why reload can keep
 * appending resume flags to the end of the argument list. Without a sandbox
 * profile the launch is returned untouched, minus the grants the session
 * record must not carry.
 */
export function wrapWithNono({ launch, executable, profile, isDirectory }) {
  const { sandboxGrants, ...rest } = launch;
  if (!profile) return { ...rest, args: [...(rest.args || [])] };
  return {
    ...rest,
    command: executable,
    args: [
      "wrap",
      "-p",
      profile,
      // A coding CLI is useless without its project directory, so the working
      // directory is granted on every sandboxed launch. The access level is the
      // sandbox profile's to decide: `--allow-cwd` takes the level from the
      // profile's `workdir` field and falls back to read-only, so a profile that
      // says nothing still confines writes.
      "--allow-cwd",
      ...grantArguments(
        [
          ...(sandboxGrants || []),
          ...INSTALLATION_GRANTS.map((path) => ({ access: "read", path })),
          ...INSTALLATION_FILE_GRANTS.map((path) => ({ access: "read", path })),
          // nono denies the interpreter's read of a shebang-script wrap
          // target ("/bin/sh: <path>: Operation not permitted"), so an
          // interpreted CLI never starts without this grant; a compiled
          // binary execs without it. The managed npm CLIs AgentPier installs
          // are not reliably one or the other.
          { access: "read", path: launch.command },
        ],
        { isDirectory },
      ),
      "--",
      launch.command,
      ...(launch.args || []),
    ],
  };
}
/**
 * The last adapter of the launch chain. It rejects a sandboxed launch it cannot
 * honour instead of starting the CLI unconfined: an operator who asked for a
 * nono sandbox never gets an unsandboxed session back.
 */
export class NonoSandbox {
  constructor({ detect, readProfiles = readSandboxProfiles }) {
    this.detect = detect;
    this.readProfiles = readProfiles;
  }
  executable() {
    return (
      this.detect().find((tool) => tool.id === "nono" && tool.installed)?.path || null
    );
  }
  async prepare({ launch, profile }) {
    if (!profile) return wrapWithNono({ launch, executable: null, profile: null });
    const executable = this.executable();
    if (!executable) throw problem(serverMessages.sessions.sandboxUnavailable);
    // Read per launch rather than per process: a sandbox profile added while
    // AgentPier runs is usable, and a removed one stops being accepted.
    const profiles = await this.readProfiles({ executable });
    if (!profiles.includes(profile))
      throw problem(serverMessages.sessions.sandboxProfileUnknown);
    return wrapWithNono({ launch, executable, profile });
  }
}
