import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { folder, readJson } from "./files.js";
import { decodeArchive, decryptCredentials } from "./archive.js";
import { backupProjects, mapProjects, historicalOnly, database } from "./restore-data.js";
import { problem } from "../../lib/storage.js";
import { AuditStore } from "../audit/audit-store.js";

const publicPath =
  /^(accounts\.json|provider-connections\.json|repositories\.json|preferences\.json|config\.json|pipelines\/definitions\.json|memory\/memory\.sqlite|pipeline-runs\/runs\.sqlite|audit\/events\.json|sessions\/[A-Za-z0-9_-]+\.(json|screen|events\.jsonl|outcome\.json)|chat\/[A-Za-z0-9_.-]+\.json|imported-history\/agentbus\/[a-f0-9]{64}\/inbox\/.+)$/;
function extract(files, target, credentials = false) {
  for (const member of files) {
    if (
      !(credentials
        ? /^(profiles\/[A-Za-z0-9_-]+\/.+|(?:repository-secrets|provider-connection-secrets)\/[A-Za-z0-9_-]+\.json)$/.test(
            member.path,
          )
        : publicPath.test(member.path))
    )
      throw problem("Unexpected backup component.");
    const file = path.join(target, member.path);
    folder(path.dirname(file));
    fs.writeFileSync(file, Buffer.from(member.content, "base64"), {
      mode: 0o600,
      flag: "wx",
    });
  }
}
export class Restore {
  constructor({ dataDir, audit }) {
    this.dataDir = fs.realpathSync(dataDir);
    this.directory = folder(path.join(this.dataDir, "operations/restores"));
    this.audit = audit;
  }
  async inspect({ archive, passphrase, projectMap } = {}) {
    const value = decodeArchive(archive);
    const manifest = value.manifest;
    if (
      typeof manifest.createdAt !== "string" ||
      !Number.isFinite(Date.parse(manifest.createdAt)) ||
      typeof manifest.applicationVersion !== "string" ||
      typeof manifest.includeHistory !== "boolean" ||
      !Array.isArray(manifest.omissions) ||
      manifest.omissions.some((item) => typeof item !== "string" || item.length > 4096) ||
      !Array.isArray(manifest.captures)
    )
      throw problem("Invalid backup manifest.");
    if (
      typeof value.manifest.withCredentials !== "boolean" ||
      Boolean(value.credentials) !== value.manifest.withCredentials
    )
      throw problem("Credential manifest does not match archive.");
    const scratch = folder(path.join(this.directory, `.inspect-${randomUUID()}`));
    try {
      extract(value.files, scratch);
      for (const file of ["memory/memory.sqlite", "pipeline-runs/runs.sqlite"])
        if (fs.existsSync(path.join(scratch, file)))
          database(
            path.join(scratch, file),
            () => {},
            file.startsWith("memory/") ? 1 : 0,
          );
      const projects = backupProjects(scratch);
      if (projectMap) await mapProjects(scratch, projectMap);
      if (value.credentials && passphrase !== undefined)
        await decryptCredentials(value.credentials, passphrase);
      return {
        manifest: value.manifest,
        projects,
        requiresPassphrase: value.manifest.withCredentials && passphrase === undefined,
        credentialsIncluded: value.manifest.withCredentials,
        omissions: value.manifest.omissions,
      };
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  async apply({ archive, targetDataDir, projectMap = {}, passphrase } = {}) {
    if (
      typeof targetDataDir !== "string" ||
      !path.isAbsolute(targetDataDir) ||
      /[\x00-\x1f]/.test(targetDataDir)
    )
      throw problem("Restore target must be an absolute fresh directory.");
    const target = path.join(
      fs.realpathSync(path.dirname(targetDataDir)),
      path.basename(targetDataDir),
    );
    if (
      target === this.dataDir ||
      target.startsWith(`${this.dataDir}${path.sep}`) ||
      fs.existsSync(target)
    )
      throw problem(
        "Restore requires a fresh target outside the live data directory.",
        409,
      );
    await this.inspect({ archive, projectMap, passphrase });
    const value = decodeArchive(archive);
    const secrets = value.credentials
      ? await decryptCredentials(value.credentials, passphrase)
      : [];
    const parentStat = fs.lstatSync(path.dirname(target));
    if (
      !parentStat.isDirectory() ||
      parentStat.isSymbolicLink() ||
      (process.getuid && parentStat.uid !== process.getuid())
    )
      throw problem("Restore parent must be a directory owned by the current user.", 409);
    const stage = folder(
      path.join(path.dirname(target), `.agentpier-restore-${randomUUID()}`),
    );
    try {
      extract(value.files, stage);
      extract(secrets, stage, true);
      const projectMappings = await mapProjects(stage, projectMap);
      const counts = historicalOnly(stage);
      const auditFile = path.join(stage, "audit/events.json");
      if (fs.existsSync(auditFile)) {
        const audit = new AuditStore({ dataDir: stage });
        try {
          audit.importEvents(readJson(auditFile));
        } finally {
          audit.close();
        }
        fs.unlinkSync(auditFile);
      }
      const accounts = readJson(path.join(stage, "accounts.json"), []);
      const credentialsNeedingLogin = accounts
        .filter(
          (a) =>
            !a.internal &&
            !secrets.some((s) => s.path === `profiles/${a.id}/secret.json`),
        )
        .map((a) => a.id);
      for (const connection of readJson(
        path.join(stage, "provider-connections.json"),
        [],
      ))
        if (
          !secrets.some(
            (member) =>
              member.path === `provider-connection-secrets/${connection.id}.json`,
          )
        )
          credentialsNeedingLogin.push(`provider:${connection.id}`);
      const repositories = readJson(path.join(stage, "repositories.json"), {
        credentials: [],
      });
      for (const credential of repositories.credentials || [])
        if (
          !secrets.some(
            (member) => member.path === `repository-secrets/${credential.id}.json`,
          )
        )
          credentialsNeedingLogin.push(`repository:${credential.id}`);
      const importRecord = {
        targetDataDir: target,
        credentialsRestored: Boolean(value.credentials),
        credentialsNeedingLogin,
        projectMappings,
        ...counts,
        omissions: value.manifest.omissions,
      };
      fs.writeFileSync(
        path.join(stage, "restore-report.json"),
        JSON.stringify(importRecord),
        { mode: 0o600, flag: "wx" },
      );
      if (fs.existsSync(target)) throw problem("Restore target now exists.", 409);
      fs.renameSync(stage, target);
      this.audit?.append({
        action: "restore.completed",
        resourceType: "restore",
        outcome: "success",
        source: "user",
      });
      return importRecord;
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
  upload(bytes) {
    decodeArchive(bytes);
    const archiveId = randomUUID();
    fs.writeFileSync(path.join(this.directory, `${archiveId}.apbackup`), bytes, {
      mode: 0o600,
      flag: "wx",
    });
    return { archiveId };
  }
}
