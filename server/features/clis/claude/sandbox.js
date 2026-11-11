// What a Claude Code launch needs before it runs inside a nono sandbox (docs/sandbox.md).
import fs from "node:fs";
import path from "node:path";
import { linkedFolderTargets } from "../linked-folders.js";

// sockaddr_un holds 104 bytes on macOS; Claude Code keeps its socket paths below that.
const SOCKET_PATH_LIMIT = 103;
// The longest process id a host hands out (Linux's pid_max ceiling has seven digits).
const LONGEST_PID = "4194304";

/**
 * The folders Claude Code may bind its cross-session socket in, resolved the way the
 * CLI does it from the environment the session gets: `<XDG_RUNTIME_DIR or
 * CLAUDE_CODE_TMPDIR or /tmp>/cc-socks/<pid>.sock`, and `/tmp/cc-socks-<uid>/` when
 * that path is too long for a socket address. The process id is unknown before the
 * launch, so a path near the limit names both folders.
 */
export function socketDirectories(env = {}, uid = 0) {
  const primary = path.join(
    env.XDG_RUNTIME_DIR || env.CLAUDE_CODE_TMPDIR || "/tmp",
    "cc-socks",
  );
  const longest = Buffer.byteLength(path.join(primary, `${LONGEST_PID}.sock`));
  return longest <= SOCKET_PATH_LIMIT
    ? [primary]
    : [primary, path.join("/tmp", `cc-socks-${uid}`)];
}

/** Creates a private folder and returns its real path, or null when it is not ours. */
function privateSocketDirectory(directory, uid) {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const real = fs.realpathSync(directory);
    const stat = fs.statSync(real);
    return stat.isDirectory() && stat.uid === uid ? real : null;
  } catch {
    return null;
  }
}

/**
 * A managed account's `skills`, `agents`, `commands` and `plugins` are links into
 * the CLI's own profile (`~/.claude`), which the account folder's grant does not
 * cover. Without them a sandboxed session loads none of the shared extensions, and
 * none of its hooks run: Claude Code creates `plugins/data/<plugin>` before it runs
 * a plugin's hook, AgentPier's own `--plugin-dir` plugins included ("hook error:
 * EPERM mkdir …/plugins/data").
 *
 * Granted are the four folders read-only and `plugins/data` read-write, never the
 * profile itself (settings, history, login). The plugin code stays read-only: an
 * unsandboxed session runs it too. Only a link that points where AgentPier points it
 * counts (linkedFolderTargets).
 */
export function sharedFolderGrants(env = {}) {
  if (!env.CLAUDE_CONFIG_DIR || !env.HOME) return [];
  const grants = [];
  for (const target of linkedFolderTargets({
    account: env.CLAUDE_CONFIG_DIR,
    native: path.join(env.HOME, ".claude"),
  })) {
    grants.push({ access: "read", path: target.path });
    if (target.name !== "plugins") continue;
    try {
      // Created here: a grant on a missing path would be a single file's.
      const data = path.join(target.path, "data");
      fs.mkdirSync(data, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(data).isDirectory()) grants.push({ access: "allow", path: data });
    } catch {
      // Left to the CLI, which reports the hook it could not run.
    }
  }
  return grants;
}

/**
 * AgentBus wakes a Claude Code session through the socket the CLI binds at start
 * (agentbus-runtime.js). A sandbox profile that does not make the shared temporary
 * folder writable denies that bind, and the session can no longer be woken. The
 * folder is created here, because the CLI could not create it inside the sandbox
 * either, and granted for binding and connecting sockets directly inside it. A folder
 * another user owns is left alone: Claude Code refuses it as well.
 */
export function sandboxLaunch(
  launch,
  { uid = process.getuid?.() ?? 0, ensure = privateSocketDirectory } = {},
) {
  const grants = [
    ...socketDirectories(launch.env, uid)
      .map((directory) => ensure(directory, uid))
      .filter(Boolean)
      .map((directory) => ({ access: "socket-dir-bind", path: directory })),
    ...sharedFolderGrants(launch.env),
  ];
  if (!grants.length) return launch;
  return { ...launch, sandboxGrants: [...(launch.sandboxGrants || []), ...grants] };
}
