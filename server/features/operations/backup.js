import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { folder, atomic, identifier, readJson } from "./files.js";
import { encodeArchive, encryptCredentials } from "./archive.js";
import { capture, omissions, backupOptions } from "./snapshot.js";
import { applicationVersion } from "./version.js";
import { problem } from "../../lib/storage.js";
import {
  assistantOmissions,
  assistantsCaptured,
  captureAssistants,
  forgetAssistantBackup,
} from "./assistant-backup.js";

export class Backup {
  constructor({
    dataDir,
    home = os.homedir(),
    audit,
    withSnapshotBarrier,
    assistantsBusy = () => false,
  }) {
    this.home = home;
    this.dataDir = fs.realpathSync(dataDir);
    this.directory = folder(path.join(this.dataDir, "operations/backups"));
    this.audit = audit;
    this.withSnapshotBarrier = withSnapshotBarrier;
    this.assistantsBusy = assistantsBusy;
    // Work folders a crash left behind may hold unsealed database copies.
    const operations = path.dirname(this.directory);
    for (const name of fs.readdirSync(operations))
      if (name.startsWith(".snapshot-"))
        fs.rmSync(path.join(operations, name), { recursive: true, force: true });
  }
  plan(input) {
    const options = backupOptions(input);
    const assistants = assistantsCaptured(this.dataDir);
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
        ...(assistants ? ["assistants"] : []),
        ...(options.withCredentials
          ? [
              "encrypted-managed-profiles",
              "encrypted-repository-credentials",
              "encrypted-provider-credentials",
              ...(assistants ? ["sealed-assistant-credentials"] : []),
            ]
          : []),
      ],
      omissions: [
        ...omissions,
        ...(assistants ? assistantOmissions : []),
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
      throw problem(serverMessages.backups.passphraseTooShort);
    const id = randomUUID();
    const take = () =>
      capture({ dataDir: this.dataDir, home: this.home, audit: this.audit, ...options });
    const snapshot = this.withSnapshotBarrier
      ? await this.withSnapshotBarrier(take)
      : take();
    // The Gateway writes independently of AgentPier's mutation barrier; its capture
    // runs after the application snapshot instead of holding every mutation.
    const assistants = await captureAssistants({
      dataDir: this.dataDir,
      id,
      withCredentials: options.withCredentials,
      busy: this.assistantsBusy,
    });
    try {
      return await this.write(id, options, plan, snapshot, assistants);
    } catch (error) {
      // A backup that was never written must not leave its assistant key behind.
      forgetAssistantBackup(this.dataDir, id);
      throw error;
    }
  }
  async write(id, options, plan, snapshot, assistants) {
    const createdAt = new Date().toISOString();
    const manifest = {
      schemaVersion: 1,
      applicationVersion: applicationVersion(),
      createdAt,
      withCredentials: options.withCredentials,
      includeHistory: options.includeHistory,
      consistency: plan.consistency,
      omissions: [...new Set([...plan.omissions, ...(assistants?.omissions || [])])],
      captures: [...snapshot.captures, ...(assistants?.captures || [])],
      ...(assistants?.manifest ? { assistants: assistants.manifest } : {}),
    };
    const archive = {
      format: "agentpier-backup",
      version: 1,
      manifest,
      files: [...snapshot.files, ...(assistants?.files || [])],
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
    if (!fs.existsSync(file)) throw problem(serverMessages.backups.notFound, 404);
    forgetAssistantBackup(this.dataDir, id);
    fs.unlinkSync(file);
    fs.rmSync(path.join(this.directory, `${id}.json`), { force: true });
  }
}
