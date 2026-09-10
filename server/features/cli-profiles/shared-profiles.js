import fs from "node:fs";
import path from "node:path";
import {
  profileLocation,
  readShared,
  applyShared,
  mergeShared,
  documents,
} from "./configuration.js";
import {
  importAssets,
  linkAssets,
  migrateSkillRecords,
  rebaseExtensions,
} from "./assets.js";
import { readJSON, writePrivate, problem } from "../../lib/storage.js";
import { safePath } from "../extensions/mcp-config.js";
import { fingerprint, synchronize } from "./synchronization.js";
import { seedBundledSkills } from "./bundled-skills.js";

export class SharedCliProfiles {
  constructor({ accounts }) {
    this.accounts = accounts;
    this.busy = new Set();
    this.file = path.join(accounts.dataDir, "shared-cli-profiles.json");
  }
  resolve(id) {
    const account = this.accounts.get(id);
    if (!["codex", "claude", "opencode"].includes(account.tool))
      throw problem("Shell has no shared CLI extensions.", 409);
    return `local-${account.tool}`;
  }
  summary(id) {
    const canonicalId = this.resolve(id);
    const state = readJSON(this.file, {});
    return {
      accountId: canonicalId,
      tool: this.accounts.get(canonicalId).tool,
      shared: true,
      conflicts: Object.entries(state)
        .filter(([key]) =>
          this.accounts.accounts.some(
            (account) => account.id === key && `local-${account.tool}` === canonicalId,
          ),
        )
        .flatMap(([accountId, value]) =>
          (value.conflicts || []).map((file) => ({ accountId, file })),
        ),
    };
  }
  migrate(id, { allowBusy = false } = {}) {
    if (!allowBusy && this.busy.has(this.resolve(id)))
      throw problem("Wait for the shared plugin operation to finish.", 409);
    const canonicalId = this.resolve(id),
      target = profileLocation(this.accounts, canonicalId);
    const state = readJSON(this.file, {});
    for (const account of this.accounts.accounts.filter(
      (account) => account.tool === target.account.tool && account.kind === "managed",
    )) {
      const source = profileLocation(this.accounts, account.id),
        conflicts = [];
      const current = readShared(target),
        incoming = rebaseExtensions(readShared(source), source, target);
      const saved = (state[account.id] ||= { profiles: {}, conflicts: [] });
      const previous = saved.profiles[source.root];
      if (previous) {
        const baseline = previous.baseline;
        if (baseline) {
          applyShared(target, synchronize(current, incoming, baseline, conflicts));
          previous.baseline = fingerprint(incoming);
          saved.conflicts = [...new Set([...saved.conflicts, ...conflicts])];
          writePrivate(this.file, state);
        }
        continue;
      }
      for (const [key, value] of Object.entries(incoming)) {
        if (current[key] && value && typeof value === "object")
          for (const [name, entry] of Object.entries(value))
            if (
              Object.hasOwn(current[key], name) &&
              JSON.stringify(current[key][name]) !== JSON.stringify(entry)
            )
              conflicts.push(`${key}.${name}`);
      }
      const copiedSkills = importAssets(source, target, conflicts);
      applyShared(target, mergeShared(current, incoming));
      migrateSkillRecords(this.accounts.dataDir, source, target, copiedSkills);
      saved.profiles[source.root] = {
        importedAt: new Date().toISOString(),
        conflicts,
        baseline: fingerprint(incoming),
      };
      saved.conflicts = [...new Set([...saved.conflicts, ...conflicts])];
      writePrivate(this.file, state);
    }
    return this.summary(id);
  }
  prepare(account, launch) {
    if (account.tool === "shell") return launch;
    this.migrate(account.id);
    const source = profileLocation(this.accounts, this.resolve(account.id));
    seedBundledSkills(this.accounts.dataDir, source);
    if (account.kind !== "managed") return launch;
    const target = profileLocation(this.accounts, account.id);
    // Preserve original mixed files before modifying only extension fields.
    for (const doc of documents(target)) {
      safePath(doc.file, target.boundary);
      const backup = doc.file + ".before-sharing";
      if (fs.existsSync(doc.file) && !fs.existsSync(backup)) {
        safePath(backup, target.boundary);
        fs.copyFileSync(doc.file, backup, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(backup, 0o600);
      }
    }
    applyShared(target, readShared(source));
    linkAssets(source, target);
    const state = readJSON(this.file, {});
    state[account.id].profiles[target.root].baseline = fingerprint(readShared(target));
    writePrivate(this.file, state);
    return launch;
  }
}
