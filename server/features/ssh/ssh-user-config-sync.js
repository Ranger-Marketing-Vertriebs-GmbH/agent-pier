// Keeps one instance's ~/.ssh/config block and its dispatcher in step with the session
// SSH agents (ssh-user-config.js has the formats and the writer). Every write is checked
// with the real `ssh -G` against the user's config: with AGENTPIER_SSH_CONFIG unset the
// output must equal the same config without this block (stdout, stderr, exit code), and
// with it set for a session, ssh must exit 0 and print no more than without the block.
// A failed check takes the session's entry, or the whole block, out again and records a
// code the session SSH dialog shows; the next agent start or sync tries again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { privateFolder, writePrivateText } from "../../lib/storage.js";
import {
  failure,
  installSshConfigInclude,
  readUserConfig,
  removeSshConfigInclude,
  renderDispatcher,
  sshConfigKey,
  withoutBlock,
} from "./ssh-user-config.js";

const CHECK_HOST = "agentpier-check.invalid";
export const SSH_CONFIG_CHECK_FAILED = "SSH_CONFIG_CHECK_FAILED";
// Only this session's entry was left out; the block itself is in place.
export const SSH_CONFIG_SESSION_LEFT_OUT = "SSH_CONFIG_SESSION_LEFT_OUT";

const inside = (folder, parent) => {
  const relative = path.relative(parent, folder);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
// The physical path; a part that does not exist yet follows its nearest existing parent.
const physical = (folder) => {
  const resolved = path.resolve(folder);
  try {
    return fs.realpathSync(resolved);
  } catch {
    const parent = path.dirname(resolved);
    return parent === resolved
      ? resolved
      : path.join(physical(parent), path.basename(resolved));
  }
};

/**
 * Whether this instance may write the user's ~/.ssh/config: not for a dev run
 * (AGENTPIER_DEV=1), not when AGENTPIER_SSH_USER_CONFIG=0 opts out (spike instances),
 * and not for a data folder under the temp folder (test servers and disposable
 * instances). A persistent instance keeps its data outside the temp folder.
 */
export function sshUserConfigEnabled({ dataDir, env = process.env, tmp = os.tmpdir() }) {
  if (env.AGENTPIER_DEV === "1" || env.AGENTPIER_SSH_USER_CONFIG === "0") return false;
  const data = physical(dataDir);
  return ![tmp, "/tmp", "/private/tmp"].some((folder) => inside(data, physical(folder)));
}

function runSsh(ssh, args, env) {
  return new Promise((resolve) => {
    execFile(
      ssh,
      args,
      { env, timeout: 10000, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
          stdout,
          stderr,
        }),
    );
  });
}

export class SshUserConfig {
  constructor({ home, dataDir, log = console, ssh = "ssh" }) {
    this.home = home;
    this.root = path.join(path.resolve(dataDir), "ssh-agents");
    this.dispatcher = path.join(this.root, "include.conf");
    this.key = sshConfigKey(dataDir);
    Object.assign(this, { log, ssh });
    this.active = false;
    this.problem = null;
    // Session config path -> code of an entry whose check failed.
    this.failed = new Map();
    this.queue = Promise.resolve();
  }

  /** The code the dialog shows for the session whose config is `configPath`. */
  problemFor(configPath) {
    return this.problem ?? this.failed.get(configPath) ?? null;
  }

  /** Rewrites the dispatcher for `entries` ({ configPath, aliases }), one at a time. */
  update(entries) {
    this.queue = this.queue.then(() => this.apply(entries)).catch(() => {});
    return this.queue;
  }

  idle() {
    return this.queue;
  }

  report(problem) {
    if (problem && problem !== this.problem)
      this.log.warn("~/.ssh/config left unchanged:", problem);
    this.problem = problem;
  }

  writeDispatcher(entries) {
    privateFolder(this.root, () => failure("SSH_FOLDER_UNSAFE"));
    writePrivateText(this.dispatcher, renderDispatcher(entries));
  }

  async apply(entries) {
    // The OpenSSH the agents resolved, not the server's PATH.
    const binary = entries.find((entry) => entry.ssh)?.ssh;
    if (binary) this.ssh = binary;
    // Nothing to name and nothing named before: no dispatcher for a user without agents.
    if (!entries.length && !this.active && !fs.existsSync(this.dispatcher)) return;
    try {
      this.writeDispatcher(entries);
    } catch (error) {
      this.log.error("Session SSH aliases for ~/.ssh/config:", error?.code || "error");
      // A data folder the block cannot name is the same fallback as a refused config.
      if (error?.code === "SSH_CONFIG_PATH_UNSUPPORTED") return this.report(error.code);
    }
    if (!this.active) {
      if (!entries.length) return;
      try {
        installSshConfigInclude({
          home: this.home,
          dispatcher: this.dispatcher,
          key: this.key,
        });
      } catch (error) {
        // Tried again on the next agent start or sync.
        return this.report(error?.code || "SSH_CONFIG_WRITE_FAILED");
      }
      this.active = true;
      this.report(null);
    }
    if (await this.verified(entries)) return this.failed.clear();
    // One entry at a time: whatever ssh cannot read stays out.
    const kept = [];
    const failed = new Map();
    if (!(await this.tryEntries(kept))) return this.rollback();
    for (const entry of entries) {
      if (await this.tryEntries([...kept, entry], [entry])) kept.push(entry);
      else failed.set(entry.configPath, SSH_CONFIG_SESSION_LEFT_OUT);
    }
    if (!(await this.tryEntries(kept))) return this.rollback();
    for (const configPath of failed.keys())
      if (!this.failed.has(configPath))
        this.log.warn(
          "Session SSH aliases left out of ~/.ssh/config:",
          SSH_CONFIG_SESSION_LEFT_OUT,
        );
    this.failed = failed;
  }

  async tryEntries(entries, checked = entries) {
    try {
      this.writeDispatcher(entries);
    } catch {
      // The check below reads whatever the file holds now.
    }
    return this.verified(checked);
  }

  /** The block out again: the user's ssh must never break because of it. */
  rollback() {
    try {
      removeSshConfigInclude({ home: this.home, key: this.key });
    } catch (error) {
      this.log.error("~/.ssh/config block could not be removed:", error?.code || "error");
    }
    this.active = false;
    this.report(SSH_CONFIG_CHECK_FAILED);
  }

  /** The real `ssh -G` on the user's config, unset and per session (see the header). */
  async verified(entries) {
    let current;
    try {
      current = readUserConfig(this.home, { create: false });
    } catch {
      return false;
    }
    if (!current?.stat) return false;
    const config = current.file;
    const baseline = path.join(
      path.dirname(config),
      `.config.agentpier-check-${randomUUID()}`,
    );
    try {
      writePrivateText(baseline, withoutBlock(current.text, this.key));
      const env = { ...process.env };
      delete env.AGENTPIER_SSH_CONFIG;
      const run = (file, extra = {}, host = CHECK_HOST) =>
        runSsh(this.ssh, ["-F", file, "-G", host], { ...env, ...extra });
      const plain = await run(baseline);
      const managed = await run(config);
      if (
        managed.code !== plain.code ||
        managed.stdout !== plain.stdout ||
        managed.stderr !== plain.stderr
      )
        return false;
      for (const { configPath, aliases } of entries) {
        const host = aliases[0] ?? CHECK_HOST;
        const own = await run(config, { AGENTPIER_SSH_CONFIG: configPath }, host);
        if (own.code !== 0 || own.stderr !== plain.stderr) return false;
      }
      return true;
    } catch {
      return false;
    } finally {
      fs.rmSync(baseline, { force: true });
    }
  }
}
