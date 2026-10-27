import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

import { problem, readJSON, writePrivate } from "../../lib/storage.js";
import { readSkillPackTracked, skillMetadata } from "./skill-packages.js";
import { record, publicMcp, safePath, readConfig } from "./mcp-config.js";
import { skillDigest } from "./skill-digest.js";
import { writeSkillFiles } from "./skill-files.js";
import { SkillPreviews } from "./skill-previews.js";
// The stable scopeKey lets browsers translate the scope; scope keeps the German label.
const skillScope = (scopeKey) => ({
  scope: serverMessages.extensions[scopeKey],
  scopeKey,
});
/** Where an installed skill came from: a pinned GitHub ref or an MCP package. */
const origins = (item) => ({
  ...(item?.origin ? { origin: item.origin } : {}),
  ...(item?.package
    ? { package: { name: item.package.name, version: item.package.version } }
    : {}),
});
export class ExtensionsStore {
  constructor({
    accounts,
    home = accounts?.home || os.homedir(),
    fetchImpl = globalThis.fetch,
    sharedProfiles,
  }) {
    this.accounts = accounts;
    this.sharedProfiles = sharedProfiles;
    this.home = home;
    this.fetchImpl = fetchImpl;
    this.file = path.join(accounts.dataDir, "extension-skills.json");
    this.active = new Map();
    this.previews = new SkillPreviews();
    this.closed = false;
  }
  locations(id) {
    if (this.sharedProfiles) id = this.sharedProfiles.resolve(id);
    const account = this.accounts.get(id);
    if (account.tool === "shell")
      throw problem(serverMessages.extensions.shellManagementUnavailable, 409);
    if (account.kind === "managed") {
      const root = this.accounts.profile(id);
      for (const name of ["codex", "claude", "config", "data", "state", "cache"])
        safePath(path.join(root, name), this.accounts.dataDir);
    }
    const env = this.accounts.environment(id);
    const boundary = account.kind === "managed" ? this.accounts.profile(id) : this.home;
    const shared = {
      path: path.join(this.home, ".agents/skills"),
      boundary: this.home,
      ...skillScope("sharedUserSkillScope"),
    };
    if (account.tool === "codex") {
      const dir = env.CODEX_HOME || path.join(this.home, ".codex");
      return {
        account,
        boundary,
        files: [path.join(dir, "config.toml")],
        key: "mcp_servers",
        target: this.sharedProfiles
          ? {
              path: path.join(dir, "skills"),
              boundary,
              ...skillScope("codexProfileSkillScope"),
            }
          : shared,
        sources: [
          shared,
          {
            path: path.join(dir, "skills"),
            boundary,
            ...skillScope("codexProfileSkillScope"),
            readOnly: !this.sharedProfiles,
          },
          {
            path: "/etc/codex/skills",
            boundary: "/etc/codex",
            ...skillScope("systemReadOnlyScope"),
            readOnly: true,
          },
        ],
      };
    }
    if (account.tool === "claude") {
      const dir = env.CLAUDE_CONFIG_DIR || path.join(this.home, ".claude");
      const target = {
        path: path.join(dir, "skills"),
        boundary,
        ...skillScope(
          account.kind === "managed" ? "claudeProfileScope" : "claudeUserScope",
        ),
      };
      return {
        account,
        boundary,
        files: [
          env.CLAUDE_CONFIG_DIR
            ? path.join(dir, ".claude.json")
            : path.join(this.home, ".claude.json"),
        ],
        key: "mcpServers",
        target,
        sources: [target],
      };
    }
    const dir = path.join(
      env.XDG_CONFIG_HOME || path.join(this.home, ".config"),
      "opencode",
    );
    const target = {
      path: path.join(dir, "skills"),
      boundary,
      ...skillScope(
        account.kind === "managed" ? "openCodeProfileScope" : "openCodeUserScope",
      ),
    };
    return {
      account,
      boundary,
      files: ["config.json", "opencode.json", "opencode.jsonc"].map((name) =>
        path.join(dir, name),
      ),
      key: "mcp",
      target,
      sources: [
        target,
        { ...shared, readOnly: true },
        {
          path: path.join(this.home, ".claude/skills"),
          boundary: this.home,
          scope: "Claude-kompatibel · geteilt",
          readOnly: true,
        },
      ],
    };
  }
  configs(locations) {
    const files = locations.files.filter((file) => fs.existsSync(file));
    return (files.length ? files : [locations.files.at(-1)]).map((file) => {
      const config = readConfig(file, locations.boundary, locations.account.tool);
      if (config.data[locations.key] !== undefined && !record(config.data[locations.key]))
        throw problem(serverMessages.extensions.invalidMcpObject, 409);
      return config;
    });
  }
  installed() {
    return readJSON(this.file, []);
  }
  list(id) {
    const locations = this.locations(id);
    const configs = this.configs(locations);
    const servers = new Map();
    for (const config of configs)
      for (const [name, entry] of Object.entries(config.data[locations.key] || {}))
        if (record(entry)) servers.set(name, publicMcp(name, entry, config.file));
    const records = this.installed();
    const skills = [];
    const visited = new Set();
    let count = 0;
    const scan = (directory, source, depth) => {
      if (depth > 4 || count >= 1000) return;
      count++;
      let real;
      try {
        real = fs.realpathSync(directory);
        if (visited.has(real)) return;
        visited.add(real);
      } catch {
        return;
      }
      const file = path.join(directory, "SKILL.md");
      try {
        if (fs.statSync(file).isFile() && fs.statSync(file).size <= 256 * 1024) {
          let metadata;
          try {
            metadata = skillMetadata(fs.readFileSync(file));
          } catch {
            metadata = {
              name: path.basename(directory),
              description: serverMessages.extensions.incompleteSkillMetadata,
            };
          }
          const stat = fs.lstatSync(directory);
          const installed = records.find(
            (item) =>
              item.path === directory && item.dev === stat.dev && item.ino === stat.ino,
          );
          skills.push({
            id:
              installed?.id || `readonly-${Buffer.from(directory).toString("base64url")}`,
            ...metadata,
            path: directory,
            scope: source.scope,
            scopeKey: source.scopeKey,
            removable: !source.readOnly && !stat.isSymbolicLink() && Boolean(installed),
            ...origins(installed),
          });
          return;
        }
      } catch {
        /* Invalid metadata is not a loadable portable skill. */
      }
      try {
        for (const child of fs
          .readdirSync(directory, { withFileTypes: true })
          .slice(0, 1000))
          if (child.isDirectory() || child.isSymbolicLink())
            scan(path.join(directory, child.name), source, depth + 1);
      } catch {
        /* Unavailable optional source. */
      }
    };
    for (const source of locations.sources) scan(source.path, source, 0);
    return {
      accountId: id,
      ...(this.sharedProfiles ? { sharing: this.sharedProfiles.summary(id) } : {}),
      tool: locations.account.tool,
      mcp: {
        path: configs.at(-1).file,
        servers: [...servers.values()],
        note: serverMessages.extensions.mcpScopeNotice,
      },
      skills: {
        installPath: locations.target.path,
        items: skills,
        note: serverMessages.extensions.skillVisibilityNotice(locations.target.scope),
        scopeKey: locations.target.scopeKey,
      },
    };
  }
  /**
   * Reads an upload or GitHub download (nothing is written) and scans it offline: the
   * preview names the verdict and findings and is confirmed through installSkill.
   */
  async previewSkill(id, input = {}) {
    if (this.closed) throw problem(serverMessages.common.serverStopping, 503);
    this.locations(id);
    const pack = await this.readPack(input);
    if (this.closed) throw problem(serverMessages.common.serverStopping, 503);
    const kind =
      input.url !== undefined
        ? "github"
        : input.fileName === "SKILL.md"
          ? "skill-md"
          : "zip";
    return this.previews.create(id, pack, kind);
  }
  /**
   * Installs a confirmed preview (`previewId`, `contentHash`, `acceptWarnings` for a
   * warning, `override.rules` for a block) exactly as scanned; `scan` in the result
   * names the decision for the audit.
   */
  async installSkill(id, input = {}) {
    this.sharedProfiles?.migrate(id);
    if (this.closed) throw problem(serverMessages.common.serverStopping, 503);
    this.locations(id);
    const preview = this.previews.take(id, input);
    try {
      const { pack, scan } = preview;
      const skill = this.writeSkill(id, pack, pack.origin ? { origin: pack.origin } : {});
      return {
        ...skill,
        scan: {
          verdict: scan.verdict,
          rules: scan.rules,
          findings: scan.findings.length,
          importKind: preview.importKind,
          overridden: preview.overridden,
        },
      };
    } catch (error) {
      this.previews.restore(preview);
      throw error;
    }
  }
  /** A skill bundled with an MCP package; `owner` ties it to the package version. */
  installPackageSkill(id, pack, owner) {
    this.sharedProfiles?.migrate(id);
    if (this.closed) throw problem(serverMessages.common.serverStopping, 503);
    return this.writeSkill(id, pack, { package: owner });
  }
  /** Reads a source (see readSkillPack); close() aborts a download in flight. */
  readPack(input) {
    return readSkillPackTracked(this.active, input, this.fetchImpl);
  }
  /** The folder a skill named `name` is installed into for profile `id`. */
  skillTarget(id, name) {
    const locations = this.locations(id);
    const target = path.join(locations.target.path, name);
    safePath(target, locations.target.boundary);
    return target;
  }
  /** Writes `pack` into a new folder of the profile and records it with `extra`. */
  writeSkill(id, pack, extra) {
    const locations = this.locations(id);
    // Account may have been deleted while an archive was downloaded.
    this.accounts.get(id);
    const target = this.skillTarget(id, pack.name);
    fs.mkdirSync(locations.target.path, { recursive: true, mode: 0o700 });
    try {
      fs.mkdirSync(target, { mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST")
        throw problem(serverMessages.extensions.skillDirectoryAlreadyExists, 409);
      throw error;
    }
    const identity = fs.lstatSync(target);
    try {
      writeSkillFiles(target, pack.files);
      const item = {
        id: randomUUID(),
        accountId: id,
        name: pack.name,
        description: pack.description,
        path: target,
        dev: identity.dev,
        ino: identity.ino,
        digest: skillDigest(target),
        ...extra,
      };
      writePrivate(this.file, [...this.installed(), item]);
      return {
        id: item.id,
        name: item.name,
        description: item.description,
        path: item.path,
        scope: locations.target.scope,
        scopeKey: locations.target.scopeKey,
        removable: true,
        ...origins(item),
      };
    } catch (error) {
      try {
        const current = fs.lstatSync(target);
        if (
          current.dev === identity.dev &&
          current.ino === identity.ino &&
          current.isDirectory()
        )
          fs.rmSync(target, { recursive: true, force: true });
      } catch {
        /* Replaced directory is not ours. */
      }
      if (error.status) throw error;
      throw problem(serverMessages.extensions.skillSaveFailed);
    }
  }
  /**
   * The record of a skill installed here whose folder is still the one written; with
   * `verify` also its content (folder identity alone survives edits and inode reuse).
   */
  ownedSkill(id, skillId, { verify = false } = {}) {
    const locations = this.locations(id);
    const records = this.installed();
    const item = records.find((item) => item.id === skillId);
    const source =
      item &&
      locations.sources.find(
        (source) => !source.readOnly && path.dirname(item.path) === source.path,
      );
    if (!source) throw problem(serverMessages.extensions.skillNotInstalledHere, 404);
    safePath(item.path, source.boundary);
    const stat = fs.lstatSync(item.path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== item.dev ||
      stat.ino !== item.ino ||
      (verify && (!item.digest || skillDigest(item.path) !== item.digest))
    )
      throw problem(serverMessages.extensions.skillDirectoryReplaced, 409);
    return { item, records };
  }
  /**
   * Replaces the files of an installed skill with `pack` (same name) in one rename:
   * a package update brings its bundled skill along. `extra` updates the record.
   * Only a copy that is still exactly what AgentPier wrote is replaced.
   */
  replaceSkill(id, skillId, pack, extra) {
    const { item, records } = this.ownedSkill(id, skillId, { verify: true });
    if (pack.name !== item.name)
      throw problem(serverMessages.extensions.skillDirectoryReplaced, 409);
    const parent = path.dirname(item.path);
    const staging = path.join(parent, `.${item.name}-${randomUUID()}`);
    const old = `${staging}-old`;
    fs.mkdirSync(staging, { mode: 0o700 });
    try {
      writeSkillFiles(staging, pack.files);
      fs.renameSync(item.path, old);
      fs.renameSync(staging, item.path);
    } catch (error) {
      if (!fs.existsSync(item.path) && fs.existsSync(old)) fs.renameSync(old, item.path);
      fs.rmSync(staging, { recursive: true, force: true });
      throw error.status ? error : problem(serverMessages.extensions.skillSaveFailed);
    }
    const identity = fs.lstatSync(item.path);
    const next = {
      ...item,
      description: pack.description,
      dev: identity.dev,
      ino: identity.ino,
      digest: skillDigest(item.path),
      ...extra,
    };
    // Recorded before the old copy goes, which is only a best-effort cleanup.
    writePrivate(
      this.file,
      records.map((record) => (record.id === skillId ? next : record)),
    );
    try {
      fs.rmSync(old, { recursive: true, force: true });
    } catch {
      /* A leftover hidden folder is harmless; the next swap uses another name. */
    }
    return next;
  }
  /** Drops the record only: the folder is no longer the one written and stays. */
  forgetSkill(skillId) {
    writePrivate(
      this.file,
      this.installed().filter((record) => record.id !== skillId),
    );
  }
  /** The profiles a skill can be installed into: one per CLI when profiles share. */
  skillProfiles() {
    const profiles = new Map();
    for (const account of this.accounts.list()) {
      if (account.tool === "shell") continue;
      let id = account.id;
      try {
        if (this.sharedProfiles) id = this.sharedProfiles.resolve(id);
      } catch {
        continue;
      }
      if (!profiles.has(id)) profiles.set(id, { id, tool: account.tool });
    }
    return [...profiles.values()];
  }
  /** `verify`: AgentPier removes on its own, so only an unchanged copy (see ownedSkill). */
  removeSkill(id, skillId, { verify = false } = {}) {
    const { item, records } = this.ownedSkill(id, skillId, { verify });
    fs.rmSync(item.path, { recursive: true });
    writePrivate(
      this.file,
      records.filter((record) => record.id !== skillId),
    );
    return { removed: skillId };
  }
  async close() {
    this.closed = true;
    this.previews.clear();
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled([...this.active.keys()]);
  }
}
