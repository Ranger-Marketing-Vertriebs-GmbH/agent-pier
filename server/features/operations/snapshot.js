import { serverMessages } from "../../lib/i18n/de.js";
import { artifactMembers } from "./artifact-backup.js";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { digest, folder, readFile, readJson } from "./files.js";
import { CapturePlan } from "./capture-plan.js";
import { areaComponent } from "./backup-components.js";
import { problem } from "../../lib/storage.js";
import { discardSearchIndex } from "../memory/memory-search.js";
import { pipelineHistoryMember } from "./private-content.js";
import {
  mcpServersPresent,
  mcpStoreMember,
  mcpValuesMember,
  sanitizeMcpStore,
} from "./mcp-server-backup.js";

export const omissions = [
  "File trash, file journals and transfer bytes",
  "Managed SSH accesses, private keys and session assignments",
  "Workspace login credentials and browser sessions",
  "MCP client grants, OAuth credentials and start request capabilities",
  "External local CLI profiles and OS keychains",
  "Shared native extensions, Agency agent files and their local installation records",
  "Repository checkouts, worktrees and uncommitted files",
  "Platform-specific installed tool binaries and caches",
  "Live native processes, delivery channels, capabilities and subscriptions",
  "Global atomicity across independent native writers",
];
export function fileMember(name, value) {
  const content = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return {
    path: name,
    content: content.toString("base64"),
    sha256: digest(content),
    mode: 0o600,
  };
}
function checkedSource(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1)
    throw problem(serverMessages.operations.invalidFile, 413);
}
/**
 * A consistent copy of `file` in `scratch`, returned as its path; `sanitize(db)`
 * edits the copy before it is vacuumed. The caller removes the copy.
 */
export function sqliteSnapshotFile(
  file,
  scratch,
  { withoutCapabilities = false, sanitize } = {},
) {
  checkedSource(file);
  const db = new DatabaseSync(file, { readOnly: true });
  const target = path.join(scratch, `${randomUUID()}.sqlite`);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.prepare("VACUUM INTO ?").run(target);
    // Copies can hold private history: owner-only, in an owner-only folder.
    fs.chmodSync(target, 0o600);
    if (withoutCapabilities || sanitize) {
      const copy = new DatabaseSync(target);
      try {
        if (withoutCapabilities) {
          copy.exec("DELETE FROM capabilities");
          // The search index is derived; the restored store rebuilds it at start.
          discardSearchIndex(copy);
        }
        sanitize?.(copy);
        // Vacuuming rewrites the file, so removed values survive in no free page.
        copy.exec("VACUUM");
      } finally {
        copy.close();
      }
    }
    return target;
  } catch (error) {
    fs.rmSync(target, { force: true });
    throw error;
  } finally {
    db.close();
  }
}
const snapshotWorker = new URL("./sqlite-snapshot-worker.js", import.meta.url);
/**
 * sqliteSnapshotFile without sanitizing, run in a worker thread: copying a large
 * native history database must not block the event loop.
 */
export async function sqliteSnapshotFileAsync(file, scratch) {
  checkedSource(file);
  const target = path.join(scratch, `${randomUUID()}.sqlite`);
  const worker = new Worker(snapshotWorker, { workerData: { file, target } });
  try {
    await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) =>
        code
          ? reject(new Error(`SQLite snapshot worker exited with ${code}`))
          : resolve(),
      );
    });
    fs.chmodSync(target, 0o600);
    return target;
  } catch (error) {
    fs.rmSync(target, { force: true });
    throw error;
  }
}
/** Reads members whose file lies in `scratch` into memory (callers without one). */
export function inlineCopies(members, scratch) {
  for (const member of members)
    if (member.file?.startsWith(scratch + path.sep)) {
      member.bytes = readFile(member.file);
      delete member.file;
      delete member.size;
    }
}
/** The bytes of a consistent copy of `file` (see sqliteSnapshotFile). */
export function sqliteSnapshot(file, scratch, options) {
  const target = sqliteSnapshotFile(file, scratch, options);
  try {
    return readFile(target);
  } finally {
    fs.rmSync(target, { force: true });
  }
}
// Only what a restore accepts is captured: a temporary file a writer left behind
// after a crash would otherwise make every restore of the backup fail.
const notChat = (name) => !/^[A-Za-z0-9_.-]+\.json$/.test(name);
const notSecret = (name) => !/^[A-Za-z0-9_-]+\.json$/.test(name);
const sealed = (members) =>
  members.map((member) => fileMember(member.path, member.bytes ?? readFile(member.file)));
/**
 * Plans the application part of a backup. Public members are `{ path, bytes }` or
 * `{ path, file, size }` (streamed later); credentials are read for the capsule.
 * Database snapshots are written to `scratch`, which must outlive the archive;
 * without one they are read into memory.
 */
export function capture({
  dataDir,
  includeHistory,
  withCredentials,
  audit,
  scratch: shared,
  plan: sharedPlan,
}) {
  const scratch =
    shared || folder(path.join(dataDir, "operations", `.snapshot-${randomUUID()}`));
  const plan = shared ? sharedPlan || new CapturePlan() : new CapturePlan();
  const files = [],
    credentials = [],
    captures = [],
    extraOmissions = [];
  const addJson = (name, transform = (v) => v) => {
    const value = readJson(path.join(dataDir, name), undefined);
    if (value !== undefined) files.push(fileMember(name, transform(value)));
  };
  const snapshotMember = (name, options, area) => {
    const file = sqliteSnapshotFile(path.join(dataDir, name), scratch, options);
    return {
      path: name,
      file,
      size: fs.statSync(file).size,
      component: area,
      temporary: true,
    };
  };
  // Histories and private content are sealed with a key from the capsule
  // (history-seal.js), so they need a passphrase; without one they are left out.
  const sealing = includeHistory && withCredentials;
  try {
    files.push(...artifactMembers(dataDir, sealing, plan));
    addJson("accounts.json", (rows) =>
      rows.map((row) => ({
        ...row,
        hasSecret: withCredentials && row.hasSecret === true,
      })),
    );
    addJson("provider-connections.json");
    addJson("repositories.json");
    addJson("preferences.json");
    addJson("pipelines/definitions.json");
    addJson("config.json", (value) => ({ port: value.port }));
    if (fs.existsSync(path.join(dataDir, "memory/memory.sqlite"))) {
      const startedAt = new Date().toISOString();
      files.push(
        snapshotMember(
          "memory/memory.sqlite",
          { withoutCapabilities: true },
          areaComponent("applicationData"),
        ),
      );
      captures.push({
        component: "memory/memory.sqlite",
        startedAt,
        finishedAt: new Date().toISOString(),
        consistency: "sqlite-snapshot",
      });
    }
    // Pipeline history holds task prompts, verdicts and findings: sealed history.
    if (sealing && fs.existsSync(path.join(dataDir, pipelineHistoryMember)))
      files.push({
        ...snapshotMember(pipelineHistoryMember, {}, areaComponent("applicationData")),
        history: true,
      });
    if (mcpServersPresent(dataDir)) {
      const startedAt = new Date().toISOString();
      let withheld;
      files.push(
        snapshotMember(
          mcpStoreMember,
          { sanitize: (db) => (withheld = sanitizeMcpStore(db)) },
          areaComponent("applicationData"),
        ),
      );
      captures.push({
        component: mcpStoreMember,
        startedAt,
        finishedAt: new Date().toISOString(),
        consistency: "sqlite-snapshot",
      });
      if (withCredentials) credentials.push(fileMember(mcpValuesMember, withheld));
    }
    if (audit?.export) files.push(fileMember("audit/events.json", audit.export()));
    else if (fs.existsSync(path.join(dataDir, "audit/audit.sqlite"))) {
      const db = new DatabaseSync(path.join(dataDir, "audit/audit.sqlite"), {
        readOnly: true,
      });
      try {
        files.push(
          fileMember(
            "audit/events.json",
            db
              .prepare("SELECT id,document FROM events ORDER BY id")
              .all()
              .map((row) => ({ ...JSON.parse(row.document), id: String(row.id) })),
          ),
        );
      } finally {
        db.close();
      }
    }
    if (sealing) {
      const history = [];
      const agentbus = areaComponent("agentbus");
      history.push(
        ...plan.tree(
          path.join(dataDir, "imported-history/agentbus"),
          "imported-history/agentbus",
          agentbus,
        ),
      );
      const sessionRoot = path.join(dataDir, "sessions");
      if (fs.existsSync(sessionRoot))
        for (const name of fs.readdirSync(sessionRoot).sort()) {
          if (
            !/^[A-Za-z0-9_-]+\.(json|screen|events\.jsonl|outcome\.json)$/.test(name) ||
            name.endsWith(".launch.json")
          )
            continue;
          const member = plan.file(
            `sessions/${name}`,
            path.join(sessionRoot, name),
            areaComponent("sessions"),
          );
          if (member) history.push(member);
        }
      history.push(
        ...plan.tree(path.join(dataDir, "chat"), "chat", areaComponent("chat"), notChat),
      );
      const busRoot = path.join(dataDir, "agentbus/projects");
      if (fs.existsSync(busRoot))
        for (const project of fs.readdirSync(busRoot).sort()) {
          if (!/^[a-f0-9]{64}$/.test(project)) continue;
          const inbox = path.join(busRoot, project, "inbox");
          history.push(
            ...plan.tree(inbox, `imported-history/agentbus/${project}/inbox`, agentbus),
          );
        }
      files.push(...history.map((member) => ({ ...member, history: true })));
      // The public manifest does not name sealed history files.
      if (history.length)
        captures.push({
          component: "agentpier-histories",
          finishedAt: new Date().toISOString(),
          consistency: "captured-file-prefix",
        });
    }
    if (withCredentials) {
      const secrets = new CapturePlan({ inlineBudget: Infinity });
      credentials.push(
        ...sealed(
          secrets.tree(
            path.join(dataDir, "provider-connection-secrets"),
            "provider-connection-secrets",
            areaComponent("providerCredentials"),
            notSecret,
          ),
        ),
        ...sealed(
          secrets.tree(
            path.join(dataDir, "repository-secrets"),
            "repository-secrets",
            areaComponent("repositoryCredentials"),
            notSecret,
          ),
        ),
      );
    }
    const unique = [...new Map(files.map((file) => [file.path, file])).values()];
    // Without a caller's scratch folder, snapshots are read before it is removed.
    if (!shared) inlineCopies(unique, scratch);
    return { files: unique, credentials, captures, omissions: extraOmissions };
  } finally {
    if (!shared) fs.rmSync(scratch, { recursive: true, force: true });
  }
}
export function backupOptions(input = {}) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !["includeHistory", "withCredentials", "passphrase"].includes(key),
    )
  )
    throw problem(serverMessages.backups.invalidOptions);
  for (const key of ["includeHistory", "withCredentials"])
    if (input[key] !== undefined && typeof input[key] !== "boolean")
      throw problem(serverMessages.backups.invalidOption);
  return {
    includeHistory: input.includeHistory !== false,
    withCredentials: input.withCredentials === true,
    passphrase: input.passphrase,
  };
}
