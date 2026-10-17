import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { folder, atomic, identifier, readJson } from "./files.js";
import { encryptCredentials } from "./archive.js";
import { SCHEMA_VERSION, writeArchive } from "./archive-v2.js";
import { ensureSpace } from "./backup-components.js";
import { captureProfiles, profileOmissions } from "./profile-capture.js";
import { CapturePlan } from "./capture-plan.js";
import { inspected } from "./inspection.js";
import { claim } from "./work-claims.js";
import { sealHistory } from "./history-seal.js";
import { backupOptions, capture, omissions } from "./snapshot.js";
import { mcpServersPresent } from "./mcp-server-backup.js";
import { applicationVersion } from "./version.js";
import { problem } from "../../lib/storage.js";
import {
  assistantOmissions,
  assistantsCaptured,
  captureAssistants,
  forgetAssistantBackup,
} from "./assistant-backup.js";
import {
  browserCachesOmission,
  browserProfilesComponent,
  browserProfilesOmission,
  captureBrowserProfiles,
} from "./browser-profile-backup.js";

export const historyOmission = profileOmissions.unsealed;
export const mcpLoginOmission = "MCP server OAuth logins";
export const mcpValueOmission =
  "MCP server header and environment values and address tokens";

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
  }
  plan(input) {
    const options = backupOptions(input);
    const assistants = assistantsCaptured(this.dataDir);
    const mcpServers = mcpServersPresent(this.dataDir);
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
        // Histories are archived only sealed, in backups with a passphrase.
        ...(options.includeHistory && options.withCredentials
          ? ["chat", "terminal", "agentbus-history", "cli-histories"]
          : []),
        ...(assistants ? ["assistants"] : []),
        ...(mcpServers ? ["mcp-servers"] : []),
        ...(options.withCredentials
          ? [
              "encrypted-managed-profiles",
              "encrypted-repository-credentials",
              "encrypted-provider-credentials",
              ...(assistants
                ? ["sealed-assistant-credentials", browserProfilesComponent]
                : []),
              ...(mcpServers ? ["encrypted-mcp-server-values"] : []),
            ]
          : []),
      ],
      omissions: [
        ...omissions,
        profileOmissions.unlisted,
        ...(!options.includeHistory
          ? [profileOmissions.history]
          : !options.withCredentials
            ? [profileOmissions.unsealed]
            : []),
        ...(assistants ? assistantOmissions : []),
        ...(assistants ? [browserCachesOmission] : []),
        ...(assistants && !options.withCredentials ? [browserProfilesOmission] : []),
        ...(mcpServers ? [mcpLoginOmission] : []),
        ...(mcpServers && !options.withCredentials ? [mcpValueOmission] : []),
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
    // Database snapshots wait here until the archive has streamed them.
    // Claimed first: the server removes unclaimed or abandoned work at its start.
    const scratchPath = path.join(
      this.dataDir,
      "operations",
      `.snapshot-${randomUUID()}`,
    );
    const releaseScratch = claim(this.dataDir, scratchPath);
    const scratch = folder(scratchPath);
    try {
      const members = new CapturePlan();
      const take = () =>
        capture({
          dataDir: this.dataDir,
          audit: this.audit,
          scratch,
          plan: members,
          ...options,
        });
      const snapshot = this.withSnapshotBarrier
        ? await this.withSnapshotBarrier(take)
        : take();
      // CLI profiles and the Gateway write independently of AgentPier's mutation
      // barrier; their captures run after the application snapshot instead of
      // holding every mutation while large history databases are copied.
      const profiles = await captureProfiles({
        dataDir: this.dataDir,
        home: this.home,
        scratch,
        plan: members,
        includeHistory: options.includeHistory,
        withCredentials: options.withCredentials,
      });
      const assistants = await captureAssistants({
        dataDir: this.dataDir,
        id,
        withCredentials: options.withCredentials,
        busy: this.assistantsBusy,
        plan: members,
        scratch,
      });
      // The agents' browser logins travel only sealed, like histories.
      const browser =
        options.withCredentials && assistants?.manifest
          ? await captureBrowserProfiles({
              dataDir: this.dataDir,
              plan: members,
              scratch,
            })
          : { files: [], omissions: [] };
      // History is sealed under a key that travels in the capsule.
      const history = sealHistory(
        id,
        [...snapshot.files, ...profiles.files, ...browser.files].filter(
          (member) => member.history,
        ),
      );
      try {
        return await this.write(
          id,
          options,
          plan,
          {
            files: [
              ...snapshot.files.filter((member) => !member.history),
              ...profiles.files.filter((member) => !member.history),
              ...history.members,
            ],
            credentials: [
              ...snapshot.credentials,
              ...profiles.credentials,
              ...(history.members.length ? [history.record] : []),
            ],
            captures: [...snapshot.captures, ...profiles.captures],
            omissions: [
              ...snapshot.omissions,
              ...profiles.omissions,
              ...browser.omissions,
            ],
          },
          assistants,
        );
      } catch (error) {
        // A backup that was never written must not leave its assistant key behind.
        forgetAssistantBackup(this.dataDir, id);
        throw error;
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
      releaseScratch();
    }
  }
  async write(id, options, plan, snapshot, assistants) {
    const createdAt = new Date().toISOString();
    // The history the backup holds: histories are archived only sealed. Older
    // backups recorded the choice, when it also meant public AgentPier history.
    const includeHistory = options.includeHistory && options.withCredentials;
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      applicationVersion: applicationVersion(),
      createdAt,
      withCredentials: options.withCredentials,
      includeHistory,
      consistency: plan.consistency,
      omissions: [
        ...new Set([
          ...plan.omissions,
          ...snapshot.omissions,
          ...(assistants?.omissions || []),
        ]),
      ],
      captures: [...snapshot.captures, ...(assistants?.captures || [])],
      ...(assistants?.manifest ? { assistants: assistants.manifest } : {}),
    };
    // What an inspection validates comes first, so it can stop reading there.
    const all = [...snapshot.files, ...(assistants?.files || [])];
    const members = [
      ...all.filter((member) => inspected(member.path)),
      ...all.filter((member) => !inspected(member.path)),
    ];
    // Compression only shrinks; the uncompressed size bounds the archive.
    ensureSpace(
      this.directory,
      members.reduce(
        (sum, member) =>
          sum +
          (member.size ??
            member.bytes?.length ??
            Math.ceil((member.content?.length || 0) * 0.75)) +
          1024,
        0,
      ),
    );
    const capsule = options.withCredentials
      ? await encryptCredentials(snapshot.credentials, options.passphrase)
      : undefined;
    const file = this.file(id),
      temporary = `${file}.${randomUUID()}.tmp`,
      release = claim(this.dataDir, temporary);
    let written;
    try {
      written = await writeArchive(temporary, { manifest, members, capsule });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
      release();
    }
    const backup = {
      id,
      createdAt,
      bytes: written.bytes,
      withCredentials: options.withCredentials,
      includeHistory,
    };
    atomic(path.join(this.directory, `${id}.json`), backup);
    this.audit?.append({
      action: "backup.created",
      resourceType: "backup",
      resourceId: id,
      outcome: "success",
      source: "user",
    });
    return { backup, manifest: written.manifest, file };
  }
  file(id) {
    const file = path.resolve(this.directory, `${identifier(id)}.apbackup`);
    if (!file.startsWith(`${this.directory}${path.sep}`))
      throw problem(serverMessages.operations.invalidIdentifier);
    return file;
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
