import { serverMessages } from "../../lib/i18n/de.js";
import { restoreArtifacts } from "./artifact-backup.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { folder, readJson } from "./files.js";
import { assertNoConflicts, decodeArchive, decryptCredentials } from "./archive.js";
import {
  archiveVersion,
  CHANGED_DURING_READ,
  readArchive,
  readArchiveHeader,
} from "./archive-v2.js";
import { backupProjects, mapProjects, historicalOnly, database } from "./restore-data.js";
import { problem } from "../../lib/storage.js";
import { mcpStoreMember, restoreMcpServers } from "./mcp-server-backup.js";
import { AuditStore } from "../audit/audit-store.js";
import {
  isAssistantMember,
  isLegacyAssistantCache,
  restoreAssistants,
  validateAssistantManifest,
} from "./assistant-backup.js";
import { ensureSpace } from "./backup-components.js";
import { isLoginFile, profileMemberKind } from "./profile-allowlist.js";
import { remapClaudeProjects } from "./profile-history.js";
import { inspected } from "./inspection.js";
import { RestoreUploads } from "./restore-upload.js";
import {
  isHistoryPath,
  isOwnHistoryPath,
  SEAL_MEMBER,
  sealRecord,
  Unsealer,
} from "./history-seal.js";
import { claim } from "./work-claims.js";
import { adoptAgentDatabases, isUnsealedPrivateContent } from "./private-content.js";
import { stagePath } from "./stage-path.js";
import { restoreUsers } from "../users/user-backup.js";

// Histories read line by line: an archived prefix of them stays valid.
const lineBased = /\.(?:jsonl|screen)$/;

// Older backups archived AgentPier's own histories as public members.
const publicPath =
  /^(artifacts\/(?:index\.json|generations\/[a-f0-9-]{36}\/\d{1,3})|accounts\.json|provider-connections\.json|repositories\.json|preferences\.json|config\.json|pipelines\/definitions\.json|memory\/memory\.sqlite|mcp-servers\/servers\.sqlite|pipeline-runs\/runs\.sqlite|audit\/events\.json|users\/users\.json|sessions\/[A-Za-z0-9_-]+\.(json|screen|events\.jsonl|outcome\.json)|chat\/[A-Za-z0-9_.-]+\.json|imported-history\/agentbus\/[a-f0-9]{64}\/inbox\/.+)$/;
const secretPath =
  /^((?:repository-secrets|provider-connection-secrets)\/[A-Za-z0-9_-]+\.json|mcp-server-secrets\/servers\.json|users\/credentials\.json)$/;
// Version 1 capsules carried whole profile folders.
const legacyProfilePath = /^profiles\/[A-Za-z0-9_-]+\/.+$/;
/** Whether `name` may be restored as a public (or, with `credentials`, sealed) member. */
function allowed(name, credentials, version) {
  if (credentials)
    return (
      secretPath.test(name) ||
      (version === 1
        ? legacyProfilePath.test(name)
        : ["secret", "credentials"].includes(profileMemberKind(name)))
    );
  return (
    publicPath.test(name) ||
    isAssistantMember(name) ||
    (version === 2 && profileMemberKind(name) === "history")
  );
}
function write(files, target, credentials, version) {
  for (const member of files) {
    if (!allowed(member.path, credentials, version))
      throw problem(serverMessages.backups.unexpectedComponent);
    const file = stagePath(target, member.path);
    folder(path.dirname(file));
    try {
      fs.writeFileSync(file, Buffer.from(member.content, "base64"), {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if (error.code === "EEXIST")
        throw problem(serverMessages.backups.caseConflict, 409);
      throw error;
    }
  }
}
function validateManifest(manifest, credentialsPresent) {
  if (
    typeof manifest.createdAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    typeof manifest.applicationVersion !== "string" ||
    typeof manifest.includeHistory !== "boolean" ||
    !Array.isArray(manifest.omissions) ||
    manifest.omissions.some((item) => typeof item !== "string" || item.length > 4096) ||
    !Array.isArray(manifest.captures)
  )
    throw problem(serverMessages.backups.invalidManifest);
  if (
    typeof manifest.withCredentials !== "boolean" ||
    credentialsPresent !== manifest.withCredentials
  )
    throw problem(serverMessages.backups.credentialManifestMismatch);
}
/** Sealed members never share a path, or a folder, with public ones. */
function checkSecrets(secrets, publicPaths, version) {
  const names = new Set(publicPaths);
  for (const member of secrets) {
    if (!allowed(member.path, true, version) || names.has(member.path))
      throw problem(serverMessages.backups.unexpectedComponent);
    names.add(member.path);
  }
  assertNoConflicts(names);
  return secrets;
}
async function capsule(bytes, passphrase) {
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw problem(serverMessages.backups.invalidEnvelope);
  }
  return decryptCredentials(value, passphrase);
}

/**
 * Reads `archive` (version 1 or 2) into `directory`. An inspection writes only the
 * members it validates and decrypts the capsule only with a passphrase; a restore
 * writes everything and requires it. Returns the manifest and decrypted secrets.
 */
async function stageArchive(archive, directory, { passphrase, inspect = false }) {
  const decrypt = !inspect || passphrase !== undefined;
  if ((await archiveVersion(archive)) === 1) {
    const value = decodeArchive(archive);
    validateManifest(value.manifest, Boolean(value.credentials));
    const contents = new Map(value.files.map((member) => [member.path, member.content]));
    validateAssistantManifest(value.manifest.assistants, [...contents.keys()], (name) =>
      Buffer.from(contents.get(name), "base64").toString("utf8"),
    );
    write(value.files, directory, false, 1);
    const secrets =
      value.credentials && decrypt
        ? checkSecrets(
            await decryptCredentials(value.credentials, passphrase),
            contents.keys(),
            1,
          )
        : null;
    return { manifest: value.manifest, secrets, version: 1, leftOut: [] };
  }
  const header = await readArchiveHeader(archive);
  const capsuleMember = header.members.find((member) => member.kind === "credentials");
  validateManifest(header.manifest, Boolean(capsuleMember));
  const publicPaths = [];
  let bytes = 0;
  for (const member of header.members) {
    if (member.kind === "credentials") continue;
    if (member.kind === "sealed") {
      // Its real path is checked once the capsule names it.
      if (!inspect) bytes += member.size;
      continue;
    }
    if (!allowed(member.path, false, 2))
      throw problem(serverMessages.backups.unexpectedComponent);
    publicPaths.push(member.path);
    if (!inspect || inspected(member.path)) bytes += member.size;
  }
  ensureSpace(directory, bytes + (capsuleMember?.size || 0));
  // Backups write what an inspection validates first; it stops reading after that.
  let count = header.members.length;
  if (inspect) {
    count = 0;
    header.members.forEach((member, index) => {
      if (member.kind === "credentials" || inspected(member.path)) count = index + 1;
    });
  }
  // Files the backup saw change while it read them: line-based histories keep
  // their valid prefix; anything else would come back corrupt and is left out.
  const changed = new Set(
    header.manifest.captures
      .filter((entry) => entry?.consistency === CHANGED_DURING_READ)
      .map((entry) => entry.component),
  );
  const leftOut = [];
  let cachesLeftOut = 0;
  let secrets = null,
    seals = null;
  await readArchive(archive, {
    count,
    visit: (member) => {
      if (member.kind === "credentials")
        return {
          // The capsule comes first: a wrong passphrase fails before any history.
          collect: async (sealed) => {
            if (!decrypt) return;
            const opened = await capsule(sealed, passphrase);
            const record = sealRecord(opened);
            seals = record?.seals || new Map();
            const histories = [...seals.values()].map((seal) => seal.path);
            const taken = new Set(publicPaths);
            for (const name of histories)
              if (!isHistoryPath(name, record.version) || taken.has(name))
                throw problem(serverMessages.backups.unexpectedComponent);
            // Backups that seal AgentPier's own histories hold none in public, and
            // those that seal private content none of that.
            if (
              record &&
              ((record.version > 1 && publicPaths.some(isOwnHistoryPath)) ||
                (record.version > 2 && publicPaths.some(isUnsealedPrivateContent)))
            )
              throw problem(serverMessages.backups.unexpectedComponent);
            secrets = checkSecrets(
              opened.filter((entry) => entry.path !== SEAL_MEMBER),
              [...publicPaths, ...histories],
              2,
            );
          },
        };
      if (member.kind === "sealed") {
        if (inspect && !seals) return null;
        const seal = seals?.get(member.path);
        if (!seal) throw problem(serverMessages.backups.unexpectedComponent);
        if (changed.has(member.path) && !lineBased.test(seal.path)) {
          leftOut.push(seal.path);
          return null;
        }
        if (inspect) return null;
        return {
          file: stagePath(directory, seal.path),
          unseal: new Unsealer(seal, member.size),
        };
      }
      // Checked again against the header this read itself validated.
      if (!allowed(member.path, false, 2))
        throw problem(serverMessages.backups.unexpectedComponent);
      if (inspect && !inspected(member.path)) return null;
      // Older backups archived browser caches; they are never restored.
      if (isLegacyAssistantCache(member.path)) {
        cachesLeftOut++;
        return null;
      }
      if (changed.has(member.path) && !lineBased.test(member.path)) {
        leftOut.push(member.path);
        return null;
      }
      return { file: stagePath(directory, member.path) };
    },
  });
  validateAssistantManifest(header.manifest.assistants, publicPaths, (name) =>
    fs.readFileSync(path.join(directory, name), "utf8"),
  );
  return { manifest: header.manifest, secrets, version: 2, leftOut, cachesLeftOut };
}
/** The checks an inspection runs on staged application data. */
function verifyStaged(directory) {
  restoreArtifacts(directory);
  for (const file of [
    "memory/memory.sqlite",
    "pipeline-runs/runs.sqlite",
    mcpStoreMember,
  ])
    if (fs.existsSync(path.join(directory, file)))
      database(path.join(directory, file), () => {}, file.startsWith("memory/") ? 1 : 0);
}
const stagePrefix = ".agentpier-restore-";

export class Restore {
  constructor({ dataDir, audit }) {
    this.dataDir = fs.realpathSync(dataDir);
    this.directory = folder(path.join(this.dataDir, "operations/restores"));
    this.audit = audit;
    this.uploads = new RestoreUploads(this.directory, this.dataDir);
  }
  /**
   * Archives handed over as bytes (tests, small uploads) are read from a file too,
   * kept in the server's own restore folder rather than beside the chosen target.
   */
  async withArchiveFile(archive, use) {
    if (!Buffer.isBuffer(archive)) return use(archive);
    const file = path.join(this.directory, `.archive-${randomUUID()}`);
    fs.writeFileSync(file, archive, { mode: 0o600, flag: "wx" });
    try {
      return await use(file);
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
  async inspect({ archive, passphrase, projectMap } = {}) {
    const scratchPath = path.join(this.directory, `.inspect-${randomUUID()}`);
    const release = claim(this.dataDir, scratchPath);
    const scratch = folder(scratchPath);
    try {
      const { manifest } = await this.withArchiveFile(archive, (file) =>
        stageArchive(file, scratch, { passphrase, inspect: true }),
      );
      verifyStaged(scratch);
      const projects = backupProjects(scratch);
      if (projectMap) await mapProjects(scratch, projectMap);
      return {
        manifest,
        projects,
        requiresPassphrase: manifest.withCredentials && passphrase === undefined,
        credentialsIncluded: manifest.withCredentials,
        omissions: manifest.omissions,
      };
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
      release();
    }
  }
  async apply({ archive, targetDataDir, projectMap = {}, passphrase } = {}) {
    if (
      typeof targetDataDir !== "string" ||
      !path.isAbsolute(targetDataDir) ||
      /[\x00-\x1f]/.test(targetDataDir)
    )
      throw problem(serverMessages.backups.restoreTargetInvalid);
    const target = path.join(
      fs.realpathSync(path.dirname(targetDataDir)),
      path.basename(targetDataDir),
    );
    if (
      target === this.dataDir ||
      target.startsWith(`${this.dataDir}${path.sep}`) ||
      fs.existsSync(target)
    )
      throw problem(serverMessages.backups.restoreTargetLive, 409);
    const parentStat = fs.lstatSync(path.dirname(target));
    if (
      !parentStat.isDirectory() ||
      parentStat.isSymbolicLink() ||
      (process.getuid && parentStat.uid !== process.getuid())
    )
      throw problem(serverMessages.backups.restoreParentInvalid, 409);
    const stageId = randomUUID();
    const stage = path.join(path.dirname(target), `${stagePrefix}${stageId}`);
    // A stage a crashed restore leaves behind is removed when the server starts.
    const release = claim(this.dataDir, stage);
    folder(stage);
    try {
      const staged = await this.withArchiveFile(archive, (file) =>
        stageArchive(file, stage, { passphrase }),
      );
      const manifest = staged.manifest,
        secrets = staged.secrets || [];
      write(secrets, stage, true, staged.version);
      adoptAgentDatabases(stage);
      verifyStaged(stage);
      const mcpServersNeedingValues = restoreMcpServers(stage);
      const assistants = await restoreAssistants({
        stage,
        target,
        liveDataDir: this.dataDir,
        value: manifest.assistants,
      });
      const projectMappings = await mapProjects(stage, projectMap);
      remapClaudeProjects(stage, projectMappings);
      const counts = historicalOnly(stage);
      const usersNeedingPassword = restoreUsers(stage);
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
      const restored = new Set(secrets.map((member) => member.path));
      const accounts = readJson(path.join(stage, "accounts.json"), []);
      // A profile stays logged in with its API key or the CLI's own login file.
      const credentialsNeedingLogin = accounts
        .filter(
          (a) =>
            !a.internal &&
            !restored.has(`profiles/${a.id}/secret.json`) &&
            ![...restored].some((name) => isLoginFile(a, name)),
        )
        .map((a) => a.id);
      for (const connection of readJson(
        path.join(stage, "provider-connections.json"),
        [],
      ))
        if (
          connection.providerId !== "endpoint" &&
          !restored.has(`provider-connection-secrets/${connection.id}.json`)
        )
          credentialsNeedingLogin.push(`provider:${connection.id}`);
      const repositories = readJson(path.join(stage, "repositories.json"), {
        credentials: [],
      });
      for (const credential of repositories.credentials || [])
        if (!restored.has(`repository-secrets/${credential.id}.json`))
          credentialsNeedingLogin.push(`repository:${credential.id}`);
      credentialsNeedingLogin.push(...mcpServersNeedingValues);
      for (const name of usersNeedingPassword)
        credentialsNeedingLogin.push(`user:${name}`);
      // Sealed agent credentials restore only while this host still holds their key.
      if (assistants.withheld) credentialsNeedingLogin.push("assistants");
      const importRecord = {
        targetDataDir: target,
        credentialsRestored: Boolean(staged.secrets),
        credentialsNeedingLogin,
        projectMappings,
        ...counts,
        omissions: manifest.omissions,
        ...(staged.leftOut.length ? { changedFilesLeftOut: staged.leftOut } : {}),
        ...(staged.cachesLeftOut ? { cachesLeftOut: staged.cachesLeftOut } : {}),
      };
      fs.writeFileSync(
        path.join(stage, "restore-report.json"),
        JSON.stringify(importRecord),
        { mode: 0o600, flag: "wx" },
      );
      if (fs.existsSync(target))
        throw problem(serverMessages.backups.restoreTargetExists, 409);
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
      release();
    }
  }
  /** Stores an archive uploaded in one request (bytes, or a stream of a known size). */
  upload(source, options) {
    return this.uploads.single(source, options);
  }
}
