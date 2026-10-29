// The one block AgentPier keeps at the top of the user's ~/.ssh/config, so a bare
// `ssh <alias>` inside a session with an SSH agent finds the session's aliases even when
// the session's `bin/` wrappers are not on PATH (an absolute /usr/bin/ssh, a tool that
// resets PATH):
//
//   # BEGIN AgentPier (managed, do not edit)
//   Match exec "test -n \"$AGENTPIER_SSH_CONFIG\""
//     Include "<dataDir>/ssh-agents/include.con[f]"
//   Match all
//   # END AgentPier
//
// Outside a session (the user's own terminal) AGENTPIER_SSH_CONFIG is unset, the Match is
// false and `ssh -G` prints exactly what it printed without the block; `Match all` makes
// the user's following lines apply as before. `Include ${AGENTPIER_SSH_CONFIG}` would
// need no dispatcher, but OpenSSH 9.9+ expands an Include path even under a false Match
// and prints "env var ${AGENTPIER_SSH_CONFIG} has no value" on every ssh where it is
// unset (and below 9.9 it does not expand at all). So the block names a fixed
// dispatcher file AgentPier rewrites as agents start and stop: one entry per session,
//
//   Match originalhost <its aliases> exec "test \"$AGENTPIER_SSH_CONFIG\" = \"<its config>\""
//     Include "<its folder>/ssh_confi[g]"
//
// `originalhost` comes first, so the user's terminal runs no command unless it connects
// to an alias name, and two sessions with the same alias each get their own. OpenSSH
// reads an Include even under a false Match, and an unreadable file aborts the whole
// config: the last character of every Include is a glob class, so a folder the sandbox
// cannot list (another session's, or `ssh-agents` itself) matches nothing instead.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { privateFolder, writePrivateText } from "../../lib/storage.js";

export const SSH_CONFIG_BEGIN = "# BEGIN AgentPier (managed, do not edit)";
export const SSH_CONFIG_END = "# END AgentPier";
export const SSH_CONFIG_BACKUP = "config.agentpier-backup";
const DISPATCHER = "include.conf";
const aliasPattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const failure = (code) => Object.assign(new Error(code), { code });

/**
 * A path as one quoted ssh_config word that `Include` reads literally: glob characters
 * are escaped and the last character becomes a class (`ssh_confi[g]`), so an unlistable
 * folder is skipped. Refuses what neither quoting nor escaping keeps literal: control
 * characters, `"`, `\`, `$` (environment variables), `%` (tokens) and a backtick.
 */
export function includeWord(file) {
  if (
    typeof file !== "string" ||
    !path.isAbsolute(file) ||
    /[\x00-\x1f\x7f"\\$%`]/.test(file)
  )
    throw failure("SSH_CONFIG_PATH_UNSUPPORTED");
  const escape = (value) => value.replace(/[*?[\]]/g, "\\$&");
  const head = file.slice(0, -1);
  const last = file.slice(-1);
  if (!/[A-Za-z0-9._-]/.test(last)) throw failure("SSH_CONFIG_PATH_UNSUPPORTED");
  return `"${escape(head)}[${last}]"`;
}

/** The marked block that includes `dispatcher` only inside an AgentPier session. */
export function renderIncludeBlock(dispatcher) {
  return [
    SSH_CONFIG_BEGIN,
    'Match exec "test -n \\"$AGENTPIER_SSH_CONFIG\\""',
    `  Include ${includeWord(dispatcher)}`,
    "Match all",
    SSH_CONFIG_END,
    "",
  ].join("\n");
}

/** The dispatcher: per session (`{ configPath, aliases }`), its aliases and config. */
export function renderDispatcher(entries) {
  const lines = ["# Managed by AgentPier: the aliases of each session's SSH agent."];
  for (const { configPath, aliases } of entries) {
    const names = [...new Set(aliases)].filter((alias) => aliasPattern.test(alias));
    if (!names.length) continue;
    const word = includeWord(configPath);
    lines.push(
      `Match originalhost ${names.join(",")} exec "test \\"$AGENTPIER_SSH_CONFIG\\" = \\"${configPath}\\""`,
      `  Include ${word}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The user's text without AgentPier's block; refuses a block without its end. */
function withoutBlock(text) {
  const lines = text.split(/(?<=\n)/);
  const kept = [];
  let inside = false;
  for (const line of lines) {
    const bare = line.replace(/\r?\n$/, "");
    if (!inside && bare === SSH_CONFIG_BEGIN) inside = true;
    else if (inside && bare === SSH_CONFIG_END) inside = false;
    else if (!inside) kept.push(line);
  }
  if (inside) throw failure("SSH_CONFIG_BLOCK_DAMAGED");
  return kept.join("");
}

const sameFile = (a, b) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** `~/.ssh/config` as `{ file, text, stat }` (stat null when missing), or a refusal. */
function readUserConfig(home, { create }) {
  const folder = path.join(home, ".ssh");
  try {
    if (!fs.statSync(folder).isDirectory()) throw failure("SSH_CONFIG_NOT_FILE");
  } catch (error) {
    if (error.code === "SSH_CONFIG_NOT_FILE") throw error;
    if (error.code !== "ENOENT") throw failure("SSH_CONFIG_UNREADABLE");
    if (!create) return null;
    try {
      fs.mkdirSync(folder, { mode: 0o700 });
    } catch {
      throw failure("SSH_CONFIG_WRITE_FAILED");
    }
  }
  const file = path.join(folder, "config");
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return { file, text: "", stat: null };
    throw failure("SSH_CONFIG_UNREADABLE");
  }
  if (stat.isSymbolicLink()) throw failure("SSH_CONFIG_LINK");
  if (!stat.isFile()) throw failure("SSH_CONFIG_NOT_FILE");
  // A rename would split a hard link from its other names.
  if (stat.nlink > 1) throw failure("SSH_CONFIG_LINK");
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const text = fs.readFileSync(fd, "utf8");
    if (!sameFile(fs.fstatSync(fd), stat)) throw failure("SSH_CONFIG_CHANGED");
    return { file, text, stat };
  } catch (error) {
    throw error.code === "SSH_CONFIG_CHANGED" ? error : failure("SSH_CONFIG_UNREADABLE");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Replaces `file` by `text` through a temp file and rename in the same folder. */
function replaceUserConfig({ file, stat }, text) {
  const mode = stat ? stat.mode & 0o777 : 0o600;
  const folder = path.dirname(file);
  if (stat) {
    // One copy of the user's own file before AgentPier's first change, never replaced.
    const backup = path.join(folder, SSH_CONFIG_BACKUP);
    try {
      fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(backup, mode & 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw failure("SSH_CONFIG_WRITE_FAILED");
    }
  }
  const tmp = path.join(folder, `.config.agentpier-${randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(tmp, "wx", mode);
    try {
      fs.fchmodSync(fd, mode);
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // The user (or an editor) changed the file meanwhile: leave it for the next run.
    let now = null;
    try {
      now = fs.lstatSync(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (stat ? !now || !sameFile(now, stat) : now) throw failure("SSH_CONFIG_CHANGED");
    fs.renameSync(tmp, file);
  } catch (error) {
    throw error.code?.startsWith("SSH_CONFIG_")
      ? error
      : failure("SSH_CONFIG_WRITE_FAILED");
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Puts the block at the very top of `<home>/.ssh/config` (creating `~/.ssh` 0700 and
 * the file 0600 when missing), keeping every other line and the file mode. Returns
 * "written" or "unchanged"; throws `{ code }` for a link, a non-file, an unreadable
 * file, a damaged block, a path the block cannot name, or a failed write.
 */
export function installSshConfigInclude({ home, dispatcher }) {
  const block = renderIncludeBlock(dispatcher);
  const current = readUserConfig(home, { create: true });
  const rest = withoutBlock(current.text);
  if (current.text === block + rest) return "unchanged";
  replaceUserConfig(current, block + rest);
  return "written";
}

/** Removes the block (uninstall): "removed", or "absent" when there is none. */
export function removeSshConfigInclude({ home }) {
  const current = readUserConfig(home, { create: false });
  if (!current?.stat) return "absent";
  const rest = withoutBlock(current.text);
  if (rest === current.text) return "absent";
  replaceUserConfig(current, rest);
  return "removed";
}

/**
 * The block and the dispatcher for SessionSshAgents. `update(entries)` rewrites the
 * dispatcher and, with at least one entry, puts the block in place once per process.
 * `problem` is the code of a refusal (the CLI hint's `ssh -F` fallback applies).
 */
export class SshUserConfig {
  constructor({ home, dataDir, log = console }) {
    this.home = home;
    this.root = path.join(path.resolve(dataDir), "ssh-agents");
    this.dispatcher = path.join(this.root, DISPATCHER);
    this.log = log;
    this.installed = false;
    this.problem = null;
  }

  update(entries) {
    // Nothing to name and nothing named before: no dispatcher for a user without agents.
    if (!entries.length && !this.installed && !fs.existsSync(this.dispatcher)) return;
    try {
      privateFolder(this.root, () => failure("SSH_FOLDER_UNSAFE"));
      writePrivateText(this.dispatcher, renderDispatcher(entries));
    } catch (error) {
      this.log.error("Session SSH aliases for ~/.ssh/config:", error?.code || "error");
      // A data folder the block cannot name is the same fallback as a refused config.
      if (error?.code === "SSH_CONFIG_PATH_UNSUPPORTED") this.problem = error.code;
      return;
    }
    if (this.installed || !entries.length) return;
    this.installed = true;
    try {
      installSshConfigInclude({ home: this.home, dispatcher: this.dispatcher });
      this.problem = null;
    } catch (error) {
      this.problem = error?.code || "SSH_CONFIG_WRITE_FAILED";
      this.log.warn("~/.ssh/config left unchanged:", this.problem);
    }
  }
}
