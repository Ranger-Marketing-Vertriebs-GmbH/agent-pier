import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { folder, atomic, identifier, readJson } from "./files.js";
import { encodeArchive, encryptCredentials } from "./archive.js";
import { capture, omissions, backupOptions } from "./snapshot.js";
import { applicationVersion } from "./version.js";
import { problem } from "../../lib/storage.js";

export class Backup {
  constructor({ dataDir, home = os.homedir(), audit, withSnapshotBarrier }) {
    this.home = home;
    this.dataDir = fs.realpathSync(dataDir);
    this.directory = folder(path.join(this.dataDir, "operations/backups"));
    this.audit = audit;
    this.withSnapshotBarrier = withSnapshotBarrier;
  }
  plan(input) {
    const options = backupOptions(input);
    return {
      components: [
        "accounts",
        "provider-connections",
        "repositories",
        "preferences",
        "pipeline-definitions",
        "memory",
        "pipeline-history",
        "audit",
        ...(options.includeHistory ? ["chat", "terminal", "agentbus-history"] : []),
        ...(options.withCredentials
          ? [
              "encrypted-managed-profiles",
              "encrypted-repository-credentials",
              "encrypted-provider-credentials",
            ]
          : []),
      ],
      omissions: [
        ...omissions,
        ...(!options.withCredentials
          ? ["Managed native configuration and credentials"]
          : []),
      ],
      consistency: this.withSnapshotBarrier
        ? "coordinated-application-snapshot; independent-native-captures"
        : "per-component-snapshots; independent-native-captures",
      requiresPassphrase: options.withCredentials,
    };
  }
  async create(input = {}) {
    const options = backupOptions(input),
      plan = this.plan(input);
    if (
      options.withCredentials &&
      (typeof options.passphrase !== "string" || options.passphrase.length < 12)
    )
      throw problem("Encrypted backups require a passphrase of at least 12 characters.");
    const take = () =>
      capture({ dataDir: this.dataDir, home: this.home, audit: this.audit, ...options });
    const snapshot = this.withSnapshotBarrier
      ? await this.withSnapshotBarrier(take)
      : take();
    const id = randomUUID(),
      createdAt = new Date().toISOString();
    const manifest = {
      schemaVersion: 1,
      applicationVersion: applicationVersion(),
      createdAt,
      withCredentials: options.withCredentials,
      includeHistory: options.includeHistory,
      consistency: plan.consistency,
      omissions: plan.omissions,
      captures: snapshot.captures,
    };
    const archive = {
      format: "agentpier-backup",
      version: 1,
      manifest,
      files: snapshot.files,
      ...(options.withCredentials
        ? {
            credentials: await encryptCredentials(
              snapshot.credentials,
              options.passphrase,
            ),
          }
        : {}),
    };
    const bytes = encodeArchive(archive),
      file = this.file(id);
    atomic(file, bytes);
    const backup = {
      id,
      createdAt,
      bytes: bytes.length,
      withCredentials: options.withCredentials,
      includeHistory: options.includeHistory,
    };
    atomic(path.join(this.directory, `${id}.json`), backup);
    this.audit?.append({
      action: "backup.created",
      resourceType: "backup",
      resourceId: id,
      outcome: "success",
      source: "user",
    });
    return { backup, manifest, file };
  }
  file(id) {
    return path.join(this.directory, `${identifier(id)}.apbackup`);
  }
  list() {
    return fs
      .readdirSync(this.directory)
      .filter((name) => /^[a-f0-9-]+\.json$/.test(name))
      .map((name) => readJson(path.join(this.directory, name)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  remove(id) {
    const file = this.file(id);
    if (!fs.existsSync(file)) throw problem("Backup not found.", 404);
    fs.unlinkSync(file);
    fs.rmSync(path.join(this.directory, `${id}.json`), { force: true });
  }
}
