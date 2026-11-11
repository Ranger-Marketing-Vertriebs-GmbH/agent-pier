import fs from "node:fs";
import path from "node:path";
import { setRepositoryConfinement } from "../../lib/git-repository-programs.js";

/**
 * Which repositories a sandboxed session works in, and under which sandbox profile:
 * what `lib/git-repository-programs.js` asks before the server runs a repository's
 * own filter programs. A repository is its common git directory, so a session in a
 * linked worktree and one in the main working tree count for the same repository.
 *
 * Read from the session records on disk (no tmux, no session lock) and kept for
 * `ttlMs`; a sandboxed launch is noted the moment it is composed (`note`), before
 * its record exists. A repository only a deleted session worked in is no longer
 * listed.
 */
const SESSION_FILE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.json$/;
const NOTE_MS = 60000;

/** The common git directory of the repository that holds `cwd`, or null. */
export function repositoryKey(cwd) {
  let folder;
  try {
    folder = fs.realpathSync(cwd);
  } catch {
    return null;
  }
  for (;;) {
    const marker = path.join(folder, ".git");
    try {
      const info = fs.statSync(marker);
      if (info.isDirectory()) return fs.realpathSync(marker);
      if (info.isFile()) {
        // A linked worktree or a submodule: `gitdir: <its git directory>`.
        const pointer = /^gitdir: (.+)$/m.exec(fs.readFileSync(marker, "utf8"));
        if (!pointer) return null;
        const gitDir = path.resolve(folder, pointer[1].trim());
        let common = gitDir;
        try {
          common = path.resolve(
            gitDir,
            fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim(),
          );
        } catch {}
        return fs.realpathSync(common);
      }
    } catch {}
    const parent = path.dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
}

export class SandboxedRepositories {
  constructor({ sessionsDirectory, executable, ttlMs = 2000, now = Date.now }) {
    Object.assign(this, { sessionsDirectory, executable, ttlMs, now });
    this.notes = new Map();
    this.index = new Map();
    this.readAt = -Infinity;
  }
  /** A sandboxed launch in `cwd` is being started under `profile`. */
  note(cwd, profile) {
    const key = profile && repositoryKey(cwd);
    if (key) this.notes.set(key, { profile, until: this.now() + NOTE_MS });
  }
  refresh() {
    const index = new Map();
    let names = [];
    try {
      names = fs.readdirSync(this.sessionsDirectory);
    } catch {}
    for (const name of names.filter((item) => SESSION_FILE.test(item)).sort())
      try {
        const session = JSON.parse(
          fs.readFileSync(path.join(this.sessionsDirectory, name), "utf8"),
        );
        const profile = session?.sandbox?.profile;
        if (typeof profile !== "string" || !profile || typeof session.cwd !== "string")
          continue;
        const key = repositoryKey(session.cwd);
        // Sessions under different profiles in one repository: the first by id.
        if (key && !index.has(key)) index.set(key, profile);
      } catch {}
    for (const [key, note] of this.notes)
      if (note.until <= this.now()) this.notes.delete(key);
    this.index = index;
    this.readAt = this.now();
  }
  /** `{ executable, profile }` for the repository that holds `cwd`, or null. */
  for(cwd) {
    const key = repositoryKey(cwd);
    if (!key) return null;
    if (this.now() - this.readAt >= this.ttlMs) this.refresh();
    const profile = this.index.get(key) ?? this.notes.get(key)?.profile;
    if (!profile) return null;
    // Without nono the filter cannot run confined, so it does not run: git reports
    // the missing program for the file instead.
    return { executable: this.executable() || "nono", profile };
  }
}

/**
 * Makes the server's own git run a repository's filter programs inside the sandbox
 * of the session that works there (`lib/git-repository-programs.js`): the sandboxed
 * sessions come from the records in `sessionsDirectory` and from every launch
 * `nonoSandbox` composes.
 */
export function confineRepositoryPrograms(nonoSandbox, sessionsDirectory) {
  const repositories = new SandboxedRepositories({
    sessionsDirectory,
    executable: () => nonoSandbox.executable(),
  });
  nonoSandbox.onSandboxed = ({ cwd, profile }) => repositories.note(cwd, profile);
  setRepositoryConfinement(async (cwd) => repositories.for(cwd));
  return repositories;
}
