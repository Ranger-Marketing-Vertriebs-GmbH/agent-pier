import fs from "node:fs";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { fileURLToPath } from "node:url";
import { privateDirectory, problem, writePrivate } from "../../lib/storage.js";
import { addGrant } from "../nono/sandbox-grants.js";
import { prepareSshDiscovery } from "../ssh/ssh-discovery.js";
import { SSH_HINT_ENV } from "../ssh/ssh-hook.js";
import { createSshProjectBinding } from "../ssh/ssh-project-scope.js";
import { writeSecretFile } from "./secret-format.js";
import { SECRETS_FILE_ENV } from "./secrets-hint.js";

export const MAX_SESSION_SECRETS = 50;
const sessionId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const tools = ["codex", "claude", "opencode", "shell"];
const hookScript = fileURLToPath(new URL("../ssh/ssh-hook.js", import.meta.url));

const fail = (message, status, code) => Object.assign(problem(message, status), { code });

/**
 * Delivers a coding-CLI session's secrets as `<data>/secrets/sessions/<id>/secrets.env`
 * (secret-format.js), outside the checkout. A session's secrets are those of its
 * project (`launch.sshTools.project`, else the launch folder's project) plus the ones
 * assigned at launch; the session learns only the file's path (SECRETS_FILE_ENV),
 * never a value. Project secret changes follow live (`syncAll`); the assignment is
 * fixed at launch. Sessions are the owner's: restricted users reach no session route.
 */
export class SessionSecrets {
  constructor({ dataDir, store, sessions }) {
    Object.assign(this, { dataDir: path.resolve(dataDir), store, sessions });
    this.queue = Promise.resolve();
  }
  folder(id) {
    if (typeof id !== "string" || !sessionId.test(id))
      throw problem(serverMessages.sessions.invalidOptions);
    return path.join(this.dataDir, "secrets", "sessions", id);
  }
  file(id) {
    return path.join(this.folder(id), "secrets.env");
  }
  /** The assigned ids of a launch body; throws 400 on a bad list, 409 on an unknown id. */
  validate(ids = []) {
    if (ids === undefined || ids === null) return [];
    if (
      !Array.isArray(ids) ||
      ids.length > MAX_SESSION_SECRETS ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== "string" || !id || id.length > 100)
    )
      throw fail(serverMessages.secrets.invalidSessionSelection, 400, "SECRET_INVALID");
    if (!ids.length) return [];
    const known = new Set(this.store.names().map(({ id }) => id));
    if (ids.some((id) => !known.has(id)))
      throw fail(serverMessages.secrets.notFound, 409, "SECRET_NOT_FOUND");
    return [...ids];
  }
  /** The launch assignment of a session record without the secrets deleted since. */
  assigned(session) {
    const ids = session?.secrets?.assignedIds;
    if (!Array.isArray(ids) || !ids.length) return [];
    const known = new Set(this.store.names().map(({ id }) => id));
    return ids.filter((id) => known.has(id));
  }
  entries({ projectId, assignedIds = [] } = {}) {
    const project = projectId ? this.store.projectEntries(projectId) : [];
    return this.store.entries([...project.map(({ id }) => id), ...assignedIds]);
  }
  /**
   * Interactive codex, claude, opencode and shell sessions; never login or headless
   * pipeline sessions, whose launch is returned unchanged. Every eligible session
   * gets its folder, the variable naming the file, the read grant and its binding,
   * also with no secrets yet, so project secrets added later reach it; the file
   * itself exists only while it has entries, and the start hint only when it has
   * entries at launch.
   */
  async prepare({ id, account, cwd, launch, purpose, headless, secretIds } = {}) {
    if (purpose === "login" || headless || !tools.includes(account?.tool)) return launch;
    const assignedIds = this.validate(secretIds);
    let projectId = launch.sshTools?.project?.projectId || null;
    if (!projectId && cwd)
      projectId = await createSshProjectBinding(cwd).then(
        (binding) => binding.projectId,
        () => null,
      );
    const folder = this.folder(id);
    privateDirectory(path.dirname(folder));
    // A fresh folder per launch: a plugin of an earlier launch never lingers.
    this.discard(id);
    privateDirectory(folder);
    if ((await fs.promises.lstat(folder)).isSymbolicLink())
      throw Object.assign(new Error("Unsafe secret folder."), {
        code: "SECRET_UNSAFE_PATH",
      });
    const entries = this.entries({ projectId, assignedIds });
    await writeSecretFile(this.file(id), entries);
    const env = { ...launch.env, [SECRETS_FILE_ENV]: this.file(id) };
    const args = [...(launch.args || [])];
    const grants = [{ access: "read", path: folder }];
    delete env[SSH_HINT_ENV];
    // A session without the SSH tools has no start hook yet: while it has secrets,
    // the same discovery hook is registered and names only the secrets file
    // (ssh-hook.js). Prepare runs again on a reload, so a later secret gets it then.
    if (entries.length && account.tool !== "shell" && launch.sshTools?.enabled !== true) {
      env[SSH_HINT_ENV] = "0";
      let plugin = folder;
      if (account.tool === "claude") {
        plugin = path.join(folder, "plugin");
        writePrivate(path.join(plugin, ".claude-plugin", "plugin.json"), {
          name: "agentpier-secrets",
          version: "1.0.0",
          description: "The start hint naming this session's secrets file.",
        });
        args.push("--plugin-dir", plugin);
      }
      prepareSshDiscovery({ tool: account.tool, folder: plugin, args, env });
      grants.push(
        { access: "read", path: process.execPath },
        { access: "read", path: hookScript },
      );
    }
    return grants.reduce((granted, grant) => addGrant(granted, grant), {
      ...launch,
      args,
      env,
      secrets: { projectId, assignedIds },
    });
  }
  eligible(session) {
    return Boolean(
      session?.secrets &&
      session.status === "running" &&
      session.purpose !== "login" &&
      !session.pipeline?.headless &&
      tools.includes(session.tool) &&
      sessionId.test(session.id),
    );
  }
  /** Resolves "written", "removed" or "unchanged"; syncs run one at a time. */
  sync(session) {
    const task = this.queue.catch(() => {}).then(() => this.syncOnce(session));
    this.queue = task;
    return task;
  }
  async syncOnce(session) {
    if (!this.eligible(session)) return "unchanged";
    // Only `prepare` creates the folder: a discarded (stopped) session stays gone,
    // also when the discard lands while this write runs.
    return writeSecretFile(
      this.file(session.id),
      this.entries({
        projectId: session.secrets.projectId,
        assignedIds: this.assigned(session),
      }),
      { create: false },
    );
  }
  /** `syncAll` after the queued syncs; calls while it waits share one pass. */
  refresh() {
    this.refreshing ??= this.queue
      .catch(() => {})
      .then(() => {
        this.refreshing = null;
        return this.syncAll();
      });
    return this.refreshing;
  }
  /** Every running session with secrets; one failing session never stops the others. */
  async syncAll() {
    let sessions = [];
    try {
      sessions = await this.sessions.list();
    } catch {
      return;
    }
    for (const session of sessions)
      if (this.eligible(session))
        await this.sync(session).catch((error) =>
          console.error(
            "Session secrets file could not be written:",
            error?.code || "error",
          ),
        );
  }
  /** Removes the session's folder; an invalid id has none. */
  discard(id) {
    if (typeof id !== "string" || !sessionId.test(id)) return;
    fs.rmSync(this.folder(id), { recursive: true, force: true });
  }
}
