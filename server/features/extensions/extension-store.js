import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

import { problem, readJSON, writePrivate } from "../../lib/storage.js";
import {
  MAX_UPLOAD,
  skillMetadata,
  unpackSkill,
  downloadSkill,
} from "./skill-packages.js";
import {
  own,
  record,
  nameValue,
  cleanMcp,
  nativeMcp,
  publicMcp,
  safePath,
  readConfig,
  updateConfig,
} from "./mcp-config.js";
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
      scope: serverMessages.extensions.sharedUserSkillScope,
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
              scope: serverMessages.extensions.codexProfileSkillScope,
            }
          : shared,
        sources: [
          shared,
          {
            path: path.join(dir, "skills"),
            boundary,
            scope: serverMessages.extensions.codexProfileSkillScope,
            readOnly: !this.sharedProfiles,
          },
          {
            path: "/etc/codex/skills",
            boundary: "/etc/codex",
            scope: serverMessages.extensions.systemReadOnlyScope,
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
        scope:
          account.kind === "managed"
            ? serverMessages.extensions.claudeProfileScope
            : serverMessages.extensions.claudeUserScope,
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
      scope:
        account.kind === "managed"
          ? serverMessages.extensions.openCodeProfileScope
          : serverMessages.extensions.openCodeUserScope,
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
            removable: !source.readOnly && !stat.isSymbolicLink() && Boolean(installed),
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
      },
    };
  }
  addMcp(id, input) {
    this.sharedProfiles?.migrate(id);
    const entry = cleanMcp(input);
    const locations = this.locations(id);
    const configs = this.configs(locations);
    if (configs.some((config) => own(config.data[locations.key] || {}, entry.name)))
      throw problem(serverMessages.extensions.mcpServerAlreadyExists, 409);
    updateConfig(
      configs.at(-1),
      locations.boundary,
      locations.account.tool,
      locations.key,
      entry.name,
      nativeMcp(locations.account.tool, entry),
    );
    return this.list(id).mcp;
  }
  removeMcp(id, name) {
    this.sharedProfiles?.migrate(id);
    nameValue(name);
    const locations = this.locations(id);
    const configs = this.configs(locations);
    const matches = configs.filter((config) =>
      own(config.data[locations.key] || {}, name),
    );
    if (matches.length > 1)
      throw problem(serverMessages.extensions.duplicateMcpName, 409);
    const config = matches[0];
    if (!config) throw problem(serverMessages.extensions.mcpServerNotFound, 404);
    updateConfig(
      config,
      locations.boundary,
      locations.account.tool,
      locations.key,
      name,
      undefined,
    );
    return this.list(id).mcp;
  }
  async installSkill(id, input = {}) {
    this.sharedProfiles?.migrate(id);
    if (this.closed) throw problem(serverMessages.common.serverStopping, 503);
    const locations = this.locations(id);
    let pack;
    if (input.url !== undefined) {
      if (input.contentBase64 !== undefined)
        throw problem(serverMessages.extensions.skillSourceRequired);
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
      const pending = downloadSkill(input.url, this.fetchImpl, signal);
      this.active.set(pending, controller);
      try {
        pack = await pending;
      } finally {
        this.active.delete(pending);
      }
    } else {
      if (
        typeof input.contentBase64 !== "string" ||
        input.contentBase64.length > Math.ceil(MAX_UPLOAD / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          input.contentBase64,
        )
      )
        throw problem(serverMessages.extensions.invalidSkillUpload);
      const buffer = Buffer.from(input.contentBase64, "base64");
      if (input.fileName === "SKILL.md")
        pack = { ...skillMetadata(buffer), files: [["SKILL.md", buffer]] };
      else if (
        typeof input.fileName === "string" &&
        input.fileName.toLowerCase().endsWith(".zip")
      )
        pack = await unpackSkill(buffer);
      else throw problem(serverMessages.extensions.skillFileTypeRequired);
    }
    if (this.closed) throw problem(serverMessages.common.serverStopping, 503);
    // Account may have been deleted while an archive was downloaded.
    this.accounts.get(id);
    const target = path.join(locations.target.path, pack.name);
    safePath(target, locations.target.boundary);
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
      for (const [relative, buffer, mode = 0o600] of pack.files) {
        const file = path.join(target, relative);
        safePath(file, target);
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, buffer, { mode, flag: "wx" });
      }
      const item = {
        id: randomUUID(),
        accountId: id,
        name: pack.name,
        description: pack.description,
        path: target,
        dev: identity.dev,
        ino: identity.ino,
      };
      writePrivate(this.file, [...this.installed(), item]);
      return {
        id: item.id,
        name: item.name,
        description: item.description,
        path: item.path,
        scope: locations.target.scope,
        removable: true,
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
  removeSkill(id, skillId) {
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
      stat.ino !== item.ino
    )
      throw problem(serverMessages.extensions.skillDirectoryReplaced, 409);
    fs.rmSync(item.path, { recursive: true });
    writePrivate(
      this.file,
      records.filter((record) => record.id !== skillId),
    );
    return { removed: skillId };
  }
  async close() {
    this.closed = true;
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled([...this.active.keys()]);
  }
}
