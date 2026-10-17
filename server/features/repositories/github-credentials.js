import { selectedCommitIdentity } from "./commit-identity.js";
import { isMainModule } from "../../lib/is-main-module.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { shellQuote as quote } from "../../lib/launch-serialization.js";
import fs from "node:fs";
import path from "node:path";
import * as toolDetection from "../accounts/account-store.js";
import { addGrant } from "../nono/sandbox-grants.js";
import { githubHelperLocation } from "./github-helper-location.js";
import { problem } from "../../lib/storage.js";
import {
  ensureDir,
  readJson,
  writeJsonAtomic,
} from "../../../vendor/agentbus/core/fsx.js";
import {
  disabledToken,
  gitCredential,
  nativeHost,
  runGitCredentialCommand,
  validId,
} from "./session-git-credential.js";
export { gitCredential, runGitCredentialCommand };
const disabledConfig = "agentpier-disabled";
// Runs after our helper for each selected host. git consults it only when ours
// returned no credential (revoked token, unreadable session files, helper failure)
// and then fails at once instead of prompting for a user name inside the agent's
// pane. The comment swallows the operation git appends and names the cause in
// git's "told us to quit" error. Other hosts keep the user's own git behaviour.
const quitHelper =
  "!echo quit=1 # AgentPier helper returned no credential for this host; see docs/github-agents.md";

const tokenKeys = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_HOST",
  "GH_REPO",
  "GH_DEBUG",
];
export class GithubCredentials {
  constructor({ dataDir, repositories, resolveGh, helperLocation } = {}) {
    this.dataDir = fs.realpathSync(dataDir);
    this.directory = path.join(this.dataDir, "github-sessions");
    this.repositories = repositories;
    this.helperLocation = helperLocation || (() => githubHelperLocation());
    this.resolveGh =
      resolveGh ||
      ((env) =>
        toolDetection
          .detectUtilities?.(env)
          ?.find((tool) => tool.id === "gh" && tool.installed)?.path || null);
  }
  folder(id) {
    if (!validId(id)) throw problem(serverMessages.common.invalidSessionId);
    return path.join(this.directory, id);
  }
  selections(cwd) {
    const selected = new Map();
    const entries = this.repositories.listCredentials();
    for (const entry of entries) {
      const host = nativeHost(entry.host);
      if (host && entry.agentDefault) selected.set(host, entry.id);
    }
    const candidates = this.repositories
      .listProjects()
      .flatMap((project) => {
        try {
          const root = fs.realpathSync(project.path);
          return cwd === root || cwd.startsWith(root + path.sep)
            ? [{ ...project, canonical: root }]
            : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.canonical.length - a.canonical.length);
    const project = candidates[0];
    if (project) {
      const entry = entries.find((item) => item.id === project.credentialId);
      let projectHost;
      try {
        projectHost = new URL(project.url).origin;
      } catch {}
      const host = entry && entry.host === projectHost && nativeHost(entry.host);
      if (host) selected.set(host, entry.id);
    }
    return [...selected].map(([host, credentialId]) => ({
      host,
      credentialId,
    }));
  }
  write(folder, selections) {
    const hosts = {};
    const entries = this.repositories.listCredentials();
    for (const selection of selections) {
      hosts[selection.host] = {
        oauth_token: disabledToken,
        git_protocol: "https",
      };
      const entry = entries.find((item) => item.id === selection.credentialId);
      if (!entry || nativeHost(entry.host) !== selection.host) continue;
      try {
        const secret = readJson(this.repositories.secretFile(entry.id));
        if (
          typeof secret.token !== "string" ||
          !secret.token ||
          secret.token.length > 16384 ||
          /[\x00-\x1f\x7f]/.test(secret.token)
        )
          continue;
        hosts[selection.host] = {
          oauth_token: secret.token,
          git_protocol: "https",
        };
      } catch {
        /* Missing or replaced secrets revoke this session copy. */
      }
    }
    writeJsonAtomic(path.join(folder, "hosts.yml"), hosts);
  }
  async prepare({ id, account, cwd, launch, purpose, replace = false } = {}) {
    // A shell gets the same access as a coding CLI: the owner runs gh and git
    // there for the agent's work. Login sessions only sign a CLI in.
    if (
      purpose === "login" ||
      !["claude", "codex", "opencode", "shell"].includes(account?.tool)
    )
      return launch;
    const canonical = fs.realpathSync(cwd);
    const selections = this.selections(canonical);
    const folder = this.folder(id);
    ensureDir(this.directory);
    if (fs.existsSync(folder) && !replace)
      throw problem(serverMessages.repositories.sessionConfigAlreadyExists, 409);
    if (replace) fs.rmSync(folder, { recursive: true, force: true });
    ensureDir(folder);
    const env = { ...launch.env };
    for (const key of tokenKeys) delete env[key];
    // Always the session folder, even without a selected connection: an empty
    // hosts.yml keeps native gh logged out instead of using the owner's login.
    env.GH_CONFIG_DIR = folder;
    env.PATH = [
      ...(env.PATH || "").split(path.delimiter),
      path.join(this.dataDir, "clis/gh/bin"),
    ]
      .filter((value, index, items) => value && items.indexOf(value) === index)
      .join(path.delimiter);
    // Native schema version prevents automatic migration and username API calls.
    writeJsonAtomic(path.join(folder, "config.yml"), { version: 1 });
    writeJsonAtomic(path.join(folder, "selection.json"), { id, selections });
    this.write(folder, selections);
    const gh = this.resolveGh(env);
    if (gh) {
      env.PATH = [path.dirname(gh), ...(env.PATH || "").split(path.delimiter)]
        .filter((value, index, items) => value && items.indexOf(value) === index)
        .join(path.delimiter);
    }
    const location = this.helperLocation();
    {
      let count = Number(env.GIT_CONFIG_COUNT || 0);
      if (!Number.isSafeInteger(count) || count < 0 || count > 256)
        throw problem(serverMessages.repositories.invalidTemporaryGitConfig);
      const helper = `!${quote(location.node)} ${quote(location.script)} --git-credential`;
      // gist.<host> serves the host's gists with the same token; without its own
      // entries the owner's global helper would answer from the session's gh folder.
      for (const { host } of selections)
        for (const url of [host, `gist.${host}`])
          for (const value of ["", helper, quitHelper]) {
            env[`GIT_CONFIG_KEY_${count}`] = `credential.https://${url}.helper`;
            env[`GIT_CONFIG_VALUE_${count}`] = value;
            count++;
          }
      const identity = selectedCommitIdentity(this.repositories, canonical, selections);
      if (identity) {
        for (const [key, value] of [
          ["user.name", identity.name],
          ["user.email", identity.email],
        ]) {
          env[`GIT_CONFIG_KEY_${count}`] = key;
          env[`GIT_CONFIG_VALUE_${count}`] = value;
          count++;
        }
        env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = identity.name;
        env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = identity.email;
      }
      env.GIT_CONFIG_COUNT = String(count);
    }
    // git runs the credential helper as a node subprocess, and native gh reads the
    // session folder holding config.yml, selection.json and hosts.yml.
    return [
      { access: "allow", path: folder },
      ...location.reads.map((target) => ({ access: "read", path: target })),
    ].reduce((granted, grant) => addGrant(granted, grant), { ...launch, env });
  }
  disable(folder) {
    // Metadata is no longer trustworthy. First make native gh reject this config,
    // then remove every cached credential; retain only inert host placeholders.
    // A non-mapping root is rejected by every gh release as an invalid config file;
    // an unknown schema version stopped working once gh 2.101 retired migrations.
    ensureDir(folder);
    writeJsonAtomic(path.join(folder, "config.yml"), disabledConfig);
    let previous = {};
    try {
      previous = readJson(path.join(folder, "hosts.yml"));
    } catch {}
    const hosts = {};
    if (previous && typeof previous === "object")
      for (const host of Object.keys(previous))
        if (nativeHost(`https://${host}`) === host)
          hosts[host] = { oauth_token: disabledToken, git_protocol: "https" };
    writeJsonAtomic(path.join(folder, "hosts.yml"), hosts);
  }
  async sync() {
    let names;
    try {
      ensureDir(this.directory);
      names = fs.readdirSync(this.directory);
    } catch (error) {
      throw problem(serverMessages.repositories.sessionConfigUnavailable, 409);
    }
    let failed = false;
    for (const id of names) {
      if (!validId(id)) continue;
      const folder = this.folder(id);
      let record;
      try {
        const stat = fs.lstatSync(folder);
        if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      } catch {
        continue;
      }
      try {
        record = readJson(path.join(folder, "selection.json"));
      } catch {}
      const valid =
        record?.id === id &&
        Array.isArray(record.selections) &&
        record.selections.length <= 1000 &&
        record.selections.every(
          (item) =>
            validId(item?.credentialId) &&
            nativeHost(`https://${item.host}`) === item.host,
        );
      try {
        if (valid) {
          this.write(folder, record.selections);
          writeJsonAtomic(path.join(folder, "config.yml"), { version: 1 });
        } else this.disable(folder);
      } catch {
        failed = true;
      }
    }
    if (failed) throw problem(serverMessages.repositories.sessionConfigUpdateFailed, 409);
  }

  /** The session's selected profiles with their last token check, without tokens. */
  status(id) {
    let record = null;
    try {
      record = readJson(path.join(this.folder(id), "selection.json"));
    } catch {}
    if (record?.id !== id || !Array.isArray(record.selections))
      return { configured: false, hosts: [] };
    const entries = this.repositories.listCredentials();
    return {
      configured: true,
      hosts: record.selections.slice(0, 100).map(({ host, credentialId }) => {
        const entry = entries.find(
          (item) => item.id === credentialId && nativeHost(item.host) === host,
        );
        return {
          host,
          ...(entry ? { credentialId, name: entry.name } : {}),
          tokenState: entry ? entry.tokenCheck?.state || null : "removed",
        };
      }),
    };
  }

  async discard(id) {
    const folder = this.folder(id);
    try {
      const stat = fs.lstatSync(folder);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return;
      if (readJson(path.join(folder, "selection.json")).id !== id) return;
      fs.rmSync(folder, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "ENOENT")
        throw problem(serverMessages.repositories.sessionConfigRemoveFailed, 409);
    }
  }
}
if (isMainModule(import.meta.url) && process.argv[2] === "--git-credential") {
  // Sessions configured before the helper moved to server/github-credentials.js.
  await runGitCredentialCommand();
}
