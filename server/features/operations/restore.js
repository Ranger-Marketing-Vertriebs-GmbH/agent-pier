import { serverMessages } from "../../lib/i18n/de.js";
import { restoreArtifacts } from "./artifact-backup.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { folder, readJson } from "./files.js";
import { assertNoConflicts, decodeArchive, decryptCredentials } from "./archive.js";
import { archiveVersion, readArchive, readArchiveHeader } from "./archive-v2.js";
import { backupProjects, mapProjects, historicalOnly, database } from "./restore-data.js";
import { problem } from "../../lib/storage.js";
import { mcpStoreMember, restoreMcpServers } from "./mcp-server-backup.js";
import { AuditStore } from "../audit/audit-store.js";
import {
  isAssistantMember,
  isRelocatableMember,
  restoreAssistants,
  validateAssistantManifest,
} from "./assistant-backup.js";
import { ensureSpace } from "./backup-components.js";
import { isLoginFile, profileMemberKind } from "./profile-allowlist.js";
import { remapClaudeProjects } from "./profile-history.js";

const publicPath =
  /^(artifacts\/(?:index\.json|generations\/[a-f0-9-]{36}\/\d{1,3})|accounts\.json|provider-connections\.json|repositories\.json|preferences\.json|config\.json|pipelines\/definitions\.json|memory\/memory\.sqlite|mcp-servers\/servers\.sqlite|pipeline-runs\/runs\.sqlite|audit\/events\.json|sessions\/[A-Za-z0-9_-]+\.(json|screen|events\.jsonl|outcome\.json)|chat\/[A-Za-z0-9_.-]+\.json|imported-history\/agentbus\/[a-f0-9]{64}\/inbox\/.+)$/;
const secretPath =
  /^((?:repository-secrets|provider-connection-secrets)\/[A-Za-z0-9_-]+\.json|mcp-server-secrets\/servers\.json)$/;
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
// An inspection reads what it validates and only verifies the history it skips.
const inspected = (name) =>
  !/^(profiles|sessions|chat|imported-history)\//.test(name) &&
  (!name.startsWith("assistants/") || isRelocatableMember(name));
function write(files, target, credentials, version) {
  for (const member of files) {
    if (!allowed(member.path, credentials, version))
      throw problem(serverMessages.backups.unexpectedComponent);
    const file = path.join(target, member.path);
    folder(path.dirname(file));
    fs.writeFileSync(file, Buffer.from(member.content, "base64"), {
      mode: 0o600,
      flag: "wx",
    });
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
async function stageArchive(source, directory, { passphrase, inspect = false }) {
  // Archives handed over as bytes (tests, small uploads) are read from a file too.
  let archive = source;
  if (Buffer.isBuffer(source)) {
    archive = path.join(directory, `.archive-${randomUUID()}`);
    fs.writeFileSync(archive, source, { mode: 0o600, flag: "wx" });
  }
  try {
    return await stageFile(archive, directory, { passphrase, inspect });
  } finally {
    if (archive !== source) fs.rmSync(archive, { force: true });
  }
}
async function stageFile(archive, directory, { passphrase, inspect }) {
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
    return { manifest: value.manifest, secrets, version: 1 };
  }
  const header = await readArchiveHeader(archive);
  const capsuleMember = header.members.find((member) => member.kind === "credentials");
  validateManifest(header.manifest, Boolean(capsuleMember));
  const publicPaths = [];
  let bytes = 0;
  for (const member of header.members) {
    if (member.kind === "credentials") continue;
    if (!allowed(member.path, false, 2))
      throw problem(serverMessages.backups.unexpectedComponent);
    publicPaths.push(member.path);
    if (!inspect || inspected(member.path)) bytes += member.size;
  }
  ensureSpace(directory, bytes + (capsuleMember?.size || 0));
  let secrets = null;
  await readArchive(archive, {
    visit: (member) => {
      if (member.kind === "credentials")
        return {
          // The capsule comes first: a wrong passphrase fails before any history.
          collect: async (sealed) => {
            if (decrypt)
              secrets = checkSecrets(await capsule(sealed, passphrase), publicPaths, 2);
          },
        };
      if (inspect && !inspected(member.path)) return null;
      return { file: path.join(directory, member.path) };
    },
  });
  validateAssistantManifest(header.manifest.assistants, publicPaths, (name) =>
    fs.readFileSync(path.join(directory, name), "utf8"),
  );
  return { manifest: header.manifest, secrets, version: 2 };
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
function cleanLeftovers(directory) {
  // Interrupted uploads and inspections leave work files behind.
  for (const name of fs.readdirSync(directory))
    if (name.startsWith(".inspect-") || name.endsWith(".upload"))
      fs.rmSync(path.join(directory, name), { recursive: true, force: true });
}
async function validateUpload(file) {
  if ((await archiveVersion(file)) === 1) decodeArchive(file);
  else await readArchiveHeader(file);
}

export class Restore {
  constructor({ dataDir, audit }) {
    this.dataDir = fs.realpathSync(dataDir);
    this.directory = folder(path.join(this.dataDir, "operations/restores"));
    this.audit = audit;
    cleanLeftovers(this.directory);
  }
  async inspect({ archive, passphrase, projectMap } = {}) {
    const scratch = folder(path.join(this.directory, `.inspect-${randomUUID()}`));
    try {
      const { manifest } = await stageArchive(archive, scratch, {
        passphrase,
        inspect: true,
      });
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
    const stage = folder(
      path.join(path.dirname(target), `.agentpier-restore-${randomUUID()}`),
    );
    try {
      const staged = await stageArchive(archive, stage, { passphrase });
      const manifest = staged.manifest,
        secrets = staged.secrets || [];
      write(secrets, stage, true, staged.version);
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
      // Sealed agent credentials restore only while this host still holds their key.
      if (assistants.withheld) credentialsNeedingLogin.push("assistants");
      const importRecord = {
        targetDataDir: target,
        credentialsRestored: Boolean(staged.secrets),
        credentialsNeedingLogin,
        projectMappings,
        ...counts,
        omissions: manifest.omissions,
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
    }
  }
  /**
   * Stores an uploaded archive (bytes or a stream) after checking its format. A
   * version 2 archive is verified member by member on inspection and restore.
   */
  async upload(source, { expectedBytes = 0 } = {}) {
    ensureSpace(this.directory, expectedBytes);
    const archiveId = randomUUID();
    const file = path.join(this.directory, `${archiveId}.apbackup`);
    const temporary = `${file}.upload`;
    try {
      if (Buffer.isBuffer(source))
        fs.writeFileSync(temporary, source, { mode: 0o600, flag: "wx" });
      else
        await pipeline(
          source,
          fs.createWriteStream(temporary, { mode: 0o600, flags: "wx" }),
        );
      await validateUpload(temporary);
      fs.renameSync(temporary, file);
      return { archiveId };
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}
