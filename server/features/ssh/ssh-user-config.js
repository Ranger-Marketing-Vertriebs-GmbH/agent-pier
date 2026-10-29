// The blocks AgentPier keeps at the top of the user's ~/.ssh/config, one per data folder,
// so a bare `ssh <alias>` inside a session with an SSH agent finds the session's aliases
// even when the session's `bin/` wrappers are not on PATH (an absolute /usr/bin/ssh, a
// tool that resets PATH):
//
//   # BEGIN AgentPier <hash8 of the data folder> (managed, do not edit)
//   Match exec "printenv AGENTPIER_SSH_CONFIG >/dev/null"
//     Include "<dataDir>/ssh-agents/include.con[f]"
//   Match all
//   # END AgentPier <hash8>
//
// Outside a session (the user's own terminal) AGENTPIER_SSH_CONFIG is unset, the Match is
// false and `ssh -G` prints exactly what it printed without the block; `Match all` makes
// the user's following lines apply as before. OpenSSH runs `exec` through `$SHELL`, so
// the commands avoid `"$VAR"` (csh and tcsh abort on an unset variable). Each instance
// owns only its own block, so several instances (a spike next to the service) coexist.
// `Include ${AGENTPIER_SSH_CONFIG}` would need no dispatcher, but OpenSSH 9.9+ expands
// an Include path even under a false Match and prints "env var … has no value" on every
// ssh where it is unset (and below 9.9 it does not expand at all). So the block names a
// fixed dispatcher file AgentPier rewrites as agents start and stop: one entry per session,
//
//   Match originalhost <its aliases> exec "printenv AGENTPIER_SSH_CONFIG | grep -qxF -- '<its config>'"
//     Include "<its folder>/ssh_confi[g]"
//
// `originalhost` comes first, so the user's terminal runs no command unless it connects
// to an alias name, and two sessions with the same alias each get their own. OpenSSH
// reads an Include even under a false Match, and an unreadable file aborts the whole
// config: the last character of every Include is a glob class, so a folder the sandbox
// cannot list (another session's, or `ssh-agents` itself) matches nothing instead, and
// ssh-user-config-sync.js checks every write with the real `ssh -G`.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const SSH_CONFIG_BACKUP = "config.agentpier-backup";
const aliasPattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export const failure = (code) => Object.assign(new Error(code), { code });

/** The block key of a data folder: 8 hex digits of its physical path. */
export function sshConfigKey(dataDir) {
  let folder = path.resolve(dataDir);
  try {
    folder = fs.realpathSync(folder);
  } catch {
    // A folder that does not exist yet keys by its resolved path.
  }
  return createHash("sha256").update(folder).digest("hex").slice(0, 8);
}

/** The first and last line of the block of `key`. */
export function blockMarkers(key) {
  if (!/^[0-9a-f]{8}$/.test(key)) throw failure("SSH_CONFIG_PATH_UNSUPPORTED");
  return {
    begin: `# BEGIN AgentPier ${key} (managed, do not edit)`,
    end: `# END AgentPier ${key}`,
  };
}

/**
 * A path as one quoted ssh_config word that `Include` reads literally: glob characters
 * are escaped and the last character becomes a class (`ssh_confi[g]`), so an unlistable
 * folder is skipped. Refuses what neither quoting nor escaping keeps literal: control
 * characters, a double quote, a backslash, a dollar sign (environment variables), `%`
 * (tokens), a backtick, and `'` and `!`, which would end or expand the single-quoted
 * path of the dispatcher's `exec`.
 */
export function includeWord(file) {
  if (
    typeof file !== "string" ||
    !path.isAbsolute(file) ||
    /[\x00-\x1f\x7f"\\$%`'!]/.test(file)
  )
    throw failure("SSH_CONFIG_PATH_UNSUPPORTED");
  const escape = (value) => value.replace(/[*?[\]]/g, "\\$&");
  const head = file.slice(0, -1);
  const last = file.slice(-1);
  if (!/[A-Za-z0-9._-]/.test(last)) throw failure("SSH_CONFIG_PATH_UNSUPPORTED");
  return `"${escape(head)}[${last}]"`;
}

/** The marked block of `key` that includes `dispatcher` only inside a session. */
export function renderIncludeBlock(dispatcher, key) {
  const { begin, end } = blockMarkers(key);
  return [
    begin,
    'Match exec "printenv AGENTPIER_SSH_CONFIG >/dev/null"',
    `  Include ${includeWord(dispatcher)}`,
    "Match all",
    end,
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
      `Match originalhost ${names.join(",")} exec "printenv AGENTPIER_SSH_CONFIG | grep -qxF -- '${configPath}'"`,
      `  Include ${word}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The user's text without the block of `key`; refuses a block without its end. */
export function withoutBlock(text, key) {
  const { begin, end } = blockMarkers(key);
  const lines = text.split(/(?<=\n)/);
  const kept = [];
  let inside = false;
  for (const line of lines) {
    const bare = line.replace(/\r?\n$/, "");
    if (!inside && bare === begin) inside = true;
    else if (inside && bare === end) inside = false;
    else if (!inside) kept.push(line);
  }
  if (inside) throw failure("SSH_CONFIG_BLOCK_DAMAGED");
  return kept.join("");
}

const sameFile = (a, b) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** `~/.ssh/config` as `{ file, text, stat }` (stat null when missing), or a refusal. */
export function readUserConfig(home, { create }) {
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
 * Puts the block of `key` at the very top of `<home>/.ssh/config` (creating `~/.ssh` 0700 and
 * the file 0600 when missing), keeping every other line and the file mode. Returns
 * "written" or "unchanged"; throws `{ code }` for a link, a non-file, an unreadable
 * file, a damaged block, a path the block cannot name, or a failed write. Blocks of
 * other keys (other instances) stay where they are.
 */
export function installSshConfigInclude({ home, dispatcher, key }) {
  const block = renderIncludeBlock(dispatcher, key);
  const current = readUserConfig(home, { create: true });
  const rest = withoutStaleBlocks(withoutBlock(current.text, key));
  if (current.text === block + rest) return "unchanged";
  replaceUserConfig(current, block + rest);
  return "written";
}

const blockStart = /^# BEGIN AgentPier ([0-9a-f]{8}) \(managed, do not edit\)\r?$/;
const includeLine = /^ {2}Include "((?:[^"\\]|\\.)*)\[(.)\]"\r?$/;

/** The data folder a block's `Include` names, or null when the block is not ours. */
function blockDataFolder(lines) {
  for (const line of lines) {
    const match = includeLine.exec(line.replace(/\n$/, ""));
    if (!match) continue;
    const dispatcher = match[1].replace(/\\(.)/g, "$1") + match[2];
    if (!path.isAbsolute(dispatcher) || path.basename(dispatcher) !== "include.conf")
      return null;
    return path.dirname(path.dirname(dispatcher));
  }
  return null;
}

/**
 * Without the blocks of other instances whose data folder no longer exists (a deleted
 * spike or test instance). Blocks of existing folders, and anything that does not
 * read as AgentPier's own block, stay.
 */
export function withoutStaleBlocks(text) {
  const lines = text.split(/(?<=\n)/);
  const kept = [];
  for (let index = 0; index < lines.length; index++) {
    const start = blockStart.exec(lines[index].replace(/\n$/, ""));
    if (!start) {
      kept.push(lines[index]);
      continue;
    }
    const end = lines.findIndex(
      (line, at) =>
        at > index && line.replace(/\r?\n$/, "") === `# END AgentPier ${start[1]}`,
    );
    if (end < 0) {
      kept.push(lines[index]);
      continue;
    }
    const block = lines.slice(index, end + 1);
    const folder = blockDataFolder(block);
    if (folder === null || fs.existsSync(folder)) kept.push(...block);
    index = end;
  }
  return kept.join("");
}

/**
 * Removes the block of `key` (uninstall, or a failed check): "removed", or "absent"
 * when there is none. A config AgentPier created (no backup of a file the user had) that
 * is empty afterwards is deleted; `~/.ssh` and the backup stay.
 */
export function removeSshConfigInclude({ home, key }) {
  const current = readUserConfig(home, { create: false });
  if (!current?.stat) return "absent";
  const rest = withoutBlock(current.text, key);
  if (rest === current.text) return "absent";
  const backup = path.join(path.dirname(current.file), SSH_CONFIG_BACKUP);
  if (!rest && !fs.existsSync(backup)) {
    if (!sameFile(fs.lstatSync(current.file), current.stat))
      throw failure("SSH_CONFIG_CHANGED");
    fs.unlinkSync(current.file);
    return "removed";
  }
  replaceUserConfig(current, rest);
  return "removed";
}
