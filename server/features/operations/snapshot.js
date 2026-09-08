import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { sharedAssetLinks } from "../cli-profiles/backup-links.js";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { digest, folder, readFile, readJson, members } from "./files.js";
import { problem } from "../../lib/storage.js";

export const omissions = [
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
export function sqliteSnapshot(file, scratch, { withoutCapabilities = false } = {}) {
  readFile(file, 256 * 1024 * 1024);
  const db = new DatabaseSync(file, { readOnly: true });
  const target = path.join(scratch, `${randomUUID()}.sqlite`);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.prepare("VACUUM INTO ?").run(target);
    if (withoutCapabilities) {
      const copy = new DatabaseSync(target);
      try {
        copy.exec("DELETE FROM capabilities; VACUUM");
      } finally {
        copy.close();
      }
    }
    return readFile(target);
  } finally {
    db.close();
    fs.rmSync(target, { force: true });
  }
}
function nativeMembers(root, prefix, scratch, sharedLinks) {
  return members(root, prefix, {
    exclude: (name) =>
      sharedLinks.has(path.join(root, name)) ||
      /(^|\/)(cache|node_modules)(\/|$)|-(wal|shm|journal)$|\.lock$/.test(name),
  }).map((member) => {
    const bytes = Buffer.from(member.content, "base64");
    if (bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")))
      return fileMember(
        member.path,
        sqliteSnapshot(path.join(root, member.path.slice(prefix.length + 1)), scratch),
      );
    return member;
  });
}
export function capture({
  dataDir,
  home = os.homedir(),
  includeHistory,
  withCredentials,
  audit,
}) {
  const scratch = folder(path.join(dataDir, "operations", `.snapshot-${randomUUID()}`));
  const files = [],
    credentials = [],
    captures = [];
  const addJson = (name, transform = (v) => v) => {
    const value = readJson(path.join(dataDir, name), undefined);
    if (value !== undefined) files.push(fileMember(name, transform(value)));
  };
  try {
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
    for (const name of ["memory/memory.sqlite", "pipeline-runs/runs.sqlite"]) {
      const file = path.join(dataDir, name);
      if (!fs.existsSync(file)) continue;
      const startedAt = new Date().toISOString();
      files.push(
        fileMember(
          name,
          sqliteSnapshot(file, scratch, {
            withoutCapabilities: name === "memory/memory.sqlite",
          }),
        ),
      );
      captures.push({
        component: name,
        startedAt,
        finishedAt: new Date().toISOString(),
        consistency: "sqlite-snapshot",
      });
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
    if (includeHistory) {
      files.push(
        ...members(
          path.join(dataDir, "imported-history/agentbus"),
          "imported-history/agentbus",
        ),
      );
      const sessionRoot = path.join(dataDir, "sessions");
      if (fs.existsSync(sessionRoot))
        for (const name of fs.readdirSync(sessionRoot)) {
          if (
            !/^[A-Za-z0-9_-]+\.(json|screen|events\.jsonl|outcome\.json)$/.test(name) ||
            name.endsWith(".launch.json")
          )
            continue;
          const bytes = readFile(path.join(sessionRoot, name));
          files.push(fileMember(`sessions/${name}`, bytes));
          captures.push({
            component: `sessions/${name}`,
            bytes: bytes.length,
            finishedAt: new Date().toISOString(),
            consistency: "captured-file-prefix",
          });
        }
      files.push(...members(path.join(dataDir, "chat"), "chat"));
      const busRoot = path.join(dataDir, "agentbus/projects");
      if (fs.existsSync(busRoot))
        for (const project of fs.readdirSync(busRoot)) {
          if (!/^[a-f0-9]{64}$/.test(project)) continue;
          const inbox = path.join(busRoot, project, "inbox");
          files.push(...members(inbox, `imported-history/agentbus/${project}/inbox`));
        }
    }
    if (withCredentials) {
      credentials.push(
        ...members(
          path.join(dataDir, "provider-connection-secrets"),
          "provider-connection-secrets",
        ),
      );
      credentials.push(
        ...nativeMembers(
          path.join(dataDir, "profiles"),
          "profiles",
          scratch,
          sharedAssetLinks(dataDir, home),
        ),
      );
      credentials.push(
        ...members(path.join(dataDir, "repository-secrets"), "repository-secrets"),
      );
    }
    return {
      files: [...new Map(files.map((file) => [file.path, file])).values()],
      credentials,
      captures,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
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
    throw problem("Invalid backup options.");
  for (const key of ["includeHistory", "withCredentials"])
    if (input[key] !== undefined && typeof input[key] !== "boolean")
      throw problem("Invalid backup option.");
  return {
    includeHistory: input.includeHistory !== false,
    withCredentials: input.withCredentials === true,
    passphrase: input.passphrase,
  };
}
