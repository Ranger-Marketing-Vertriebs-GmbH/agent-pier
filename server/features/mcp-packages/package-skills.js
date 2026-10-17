import fs from "node:fs";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { packageProblem } from "./package-errors.js";
import { logFailure } from "./package-install-job.js";
import { bundledSkills, skillPack } from "./package-skill-scan.js";
import { npmPackageDirectory } from "./package-store.js";

const invalid = () => packageProblem("MCP_PACKAGE_INVALID", 400);
const unreadable = () => problem(serverMessages.extensions.packageSkillUnreadable, 409);

/**
 * Skills an MCP package bundles (docs/mcp.md). They are offered once the package is
 * installed and copied only after the owner confirmed them for one profile; AgentPier
 * owns the copies: a package update replaces them with the new version's, a version
 * without them and the package's removal remove them. A copy the owner changed,
 * replaced or removed is no longer owned and never touched again.
 */
export class PackageSkills {
  constructor(service, extensions) {
    this.service = service;
    this.extensions = extensions;
  }
  /** The ready install's skills (metadata only), or null while no install is usable. */
  async bundled(row) {
    // npm only: a PyPI wheel has no package folder of its own to ship skills in.
    if (row?.registry !== "npm" || row.status !== "ready" || !row.installId) return null;
    const dir = npmPackageDirectory(this.service.dataDir, row);
    return dir ? bundledSkills(dir) : null;
  }
  owned(serverId) {
    return this.extensions
      .installed()
      .filter((item) => item.package?.serverId === serverId);
  }
  owner(serverId, row) {
    return { serverId, registry: row.registry, name: row.name, version: row.version };
  }
  async list(serverId) {
    this.service.servers.get(serverId);
    const row = this.service.records.get(serverId);
    if (!row) throw invalid();
    const skills = await this.bundled(row);
    const owned = this.owned(serverId);
    return {
      name: row.name,
      version: row.version,
      available: skills !== null,
      profiles: this.extensions.skillProfiles(),
      skills: (skills ?? []).map((skill) => ({
        name: skill.name,
        description: skill.description,
        // Shown as plain text for review before anything is copied.
        document: skill.document,
        files: skill.files,
        size: skill.size,
        installed: owned
          .filter((item) => item.name === skill.name)
          .map((item) => ({ profileId: item.accountId, version: item.package.version })),
      })),
    };
  }
  /**
   * Copies the named skills into one profile. Every target is checked first, so a
   * refusal writes none; a skill this package already owns there is left as it is.
   */
  async install(serverId, { profileId, names, confirmInstall } = {}) {
    if (confirmInstall !== true)
      throw packageProblem("MCP_PACKAGE_CONFIRMATION_REQUIRED", 409);
    if (
      typeof profileId !== "string" ||
      !Array.isArray(names) ||
      !names.length ||
      names.length > 50 ||
      names.some((name) => typeof name !== "string")
    )
      throw invalid();
    this.service.servers.get(serverId);
    this.service.requireIdle(serverId);
    const row = this.service.records.get(serverId);
    const skills = await this.bundled(row);
    if (!skills) throw problem(serverMessages.extensions.packageSkillsUnavailable, 409);
    const owned = this.owned(serverId);
    const pending = [];
    for (const name of new Set(names)) {
      const skill = skills.find((item) => item.name === name);
      if (!skill) throw problem(serverMessages.extensions.packageSkillNotFound, 404);
      const target = this.extensions.skillTarget(profileId, name);
      if (owned.some((item) => item.path === target)) continue;
      if (fs.existsSync(target))
        throw problem(serverMessages.extensions.skillDirectoryAlreadyExists, 409);
      pending.push(skill);
    }
    const packs = [];
    for (const skill of pending)
      packs.push(
        await skillPack(skill).catch(() => {
          throw unreadable();
        }),
      );
    // Another install may have run while the files were read.
    this.service.requireIdle(serverId);
    for (const pack of packs)
      this.extensions.installPackageSkill(profileId, pack, this.owner(serverId, row));
    // The listing again, which names no host path (unlike the Skills page).
    return this.list(serverId);
  }
  /** After an install switched the server: owned copies follow the installed version. */
  async sync(serverId) {
    const owned = this.owned(serverId);
    if (!owned.length) return;
    const row = this.service.records.get(serverId);
    const skills = await this.bundled(row);
    if (!skills) return;
    for (const item of owned) {
      const skill = skills.find((found) => found.name === item.name);
      let pack = null;
      try {
        pack = skill ? await skillPack(skill) : null;
      } catch (error) {
        logFailure("read a skill of an MCP package", error);
        continue;
      }
      this.settle(item, () =>
        pack
          ? this.extensions.replaceSkill(item.accountId, item.id, pack, {
              package: this.owner(serverId, row),
            })
          : this.extensions.removeSkill(item.accountId, item.id, { verify: true }),
      );
    }
  }
  /** The package or its server went: so do the unchanged copies it still owns. */
  remove(serverId) {
    for (const item of this.owned(serverId))
      this.settle(item, () =>
        this.extensions.removeSkill(item.accountId, item.id, { verify: true }),
      );
  }
  /** Copies of packages removed while AgentPier was stopped. */
  prune(serverIds) {
    for (const item of this.extensions.installed())
      if (item.package && !serverIds.has(item.package.serverId))
        this.settle(item, () =>
          this.extensions.removeSkill(item.accountId, item.id, { verify: true }),
        );
  }
  settle(item, change) {
    try {
      change();
    } catch (error) {
      // A folder changed, moved or removed by the owner (or a removed profile) is
      // theirs now: only the record goes.
      if (error?.status === 409 || error?.status === 404 || error?.code === "ENOENT")
        this.extensions.forgetSkill(item.id);
      else logFailure("update a skill of an MCP package", error);
    }
  }
}
