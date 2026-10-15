import { installDirectory, readInstall } from "./package-store.js";

const schema = (table) => `
CREATE TABLE IF NOT EXISTS ${table}(
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  registry TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL,
  program TEXT NOT NULL, program_path TEXT NOT NULL, allow_scripts INTEGER NOT NULL DEFAULT 0,
  lock TEXT NOT NULL, lock_digest TEXT NOT NULL, integrity TEXT NOT NULL,
  install_id TEXT, leading_args INTEGER NOT NULL DEFAULT 0, toolchain_dir TEXT,
  status TEXT NOT NULL CHECK(status IN ('installing','ready','failed','choosing')),
  error_code TEXT, updated_at INTEGER NOT NULL,
  constraints TEXT NOT NULL DEFAULT '[]', needs_scripts INTEGER NOT NULL DEFAULT 0);`;
// Columns added after plan 2; a store created then gains them when it opens.
const addedColumns = [
  ["constraints", "TEXT NOT NULL DEFAULT '[]'"],
  // npm ignores needsScripts; only PyPI reads it. Before the column a reinstall
  // without receipt built when the owner allowed it.
  ["needs_scripts", "INTEGER NOT NULL DEFAULT 0", "allow_scripts"],
];
const columns = {
  registry: "registry",
  name: "name",
  version: "version",
  program: "program",
  programPath: "program_path",
  allowScripts: "allow_scripts",
  lock: "lock",
  lockDigest: "lock_digest",
  integrity: "integrity",
  installId: "install_id",
  leadingArgs: "leading_args",
  toolchainDir: "toolchain_dir",
  status: "status",
  errorCode: "error_code",
  constraints: "constraints",
  needsScripts: "needs_scripts",
};
/** The stored constraint lines; anything but a JSON list of strings reads as none. */
function parsedList(text) {
  try {
    const list = JSON.parse(text);
    return Array.isArray(list) && list.every((line) => typeof line === "string")
      ? list
      : [];
  } catch {
    return [];
  }
}
const fromRow = (row) =>
  row && {
    serverId: row.server_id,
    ...Object.fromEntries(
      Object.entries(columns).map(([key, column]) => [key, row[column]]),
    ),
    allowScripts: row.allow_scripts === 1,
    needsScripts: row.needs_scripts === 1,
    constraints: parsedList(row.constraints),
    updatedAt: row.updated_at,
  };
function toValue(key, value) {
  if (key === "allowScripts" || key === "needsScripts") return value ? 1 : 0;
  if (key === "constraints") return JSON.stringify(Array.isArray(value) ? value : []);
  return value ?? null;
}

/** One package source per server, beside the servers it belongs to (and backed up with them). */
export class PackageRecords {
  constructor(db, dataDir) {
    Object.assign(this, { db, dataDir });
    // A current table opens without a write lock; anything else migrates in one
    // transaction: the table, added columns, their backfill and a rebuilt status check
    // land together or not at all (SQLite DDL is transactional).
    if (this.migrationNeeded()) {
      db.exec("BEGIN IMMEDIATE");
      try {
        // Checked again under the lock: another open may have migrated meanwhile.
        if (this.migrationNeeded()) this.migrate();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    // McpPackages answers this: an `installing` row no job owns (a restore, a crash
    // before start()) reads as failed instead of installing forever.
    this.orphaned = () => false;
  }
  tableColumns() {
    return new Set(
      this.db
        .prepare("PRAGMA table_info(server_packages)")
        .all()
        .map((column) => column.name),
    );
  }
  tableSql() {
    return (
      this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .get("server_packages")?.sql ?? null
    );
  }
  migrationNeeded() {
    const sql = this.tableSql();
    if (!sql || !sql.includes("'choosing'")) return true;
    const known = this.tableColumns();
    return addedColumns.some(([name]) => !known.has(name));
  }
  migrate() {
    const { db } = this;
    db.exec(schema("server_packages"));
    const known = this.tableColumns();
    for (const [name, type, from] of addedColumns)
      if (!known.has(name)) {
        db.exec(`ALTER TABLE server_packages ADD COLUMN ${name} ${type}`);
        if (from) db.exec(`UPDATE server_packages SET ${name}=${from}`);
      }
    // A table from before the choose-program state: SQLite cannot alter its CHECK, so
    // the rows move to a rebuilt table. Nothing references server_packages; the copy
    // re-checks each row's server.
    if (!this.tableSql().includes("'choosing'")) {
      const names = ["server_id", ...Object.values(columns), "updated_at"].join(",");
      db.exec("DROP TABLE IF EXISTS server_packages_next");
      db.exec(schema("server_packages_next"));
      db.exec(
        `INSERT INTO server_packages_next(${names}) SELECT ${names} FROM server_packages`,
      );
      db.exec("DROP TABLE server_packages");
      db.exec("ALTER TABLE server_packages_next RENAME TO server_packages");
    }
  }
  get(serverId) {
    return (
      fromRow(
        this.db.prepare("SELECT * FROM server_packages WHERE server_id=?").get(serverId),
      ) ?? null
    );
  }
  all() {
    return this.db.prepare("SELECT * FROM server_packages").all().map(fromRow);
  }
  put(serverId, fields) {
    const keys = Object.keys(columns);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO server_packages(server_id,${keys.map((k) => columns[k]).join(",")},updated_at) VALUES (?,${keys.map(() => "?").join(",")},?)`,
      )
      .run(serverId, ...keys.map((k) => toValue(k, fields[k])), Date.now());
  }
  update(serverId, fields) {
    const current = this.get(serverId);
    if (current) this.put(serverId, { ...current, ...fields });
  }
  remove(serverId) {
    this.db.prepare("DELETE FROM server_packages WHERE server_id=?").run(serverId);
  }
  installIds() {
    return new Set(
      this.all()
        .map((row) => row.installId)
        .filter(Boolean),
    );
  }
  computedStatus(row) {
    if (row.status === "installing" && this.orphaned(row.serverId)) return "failed";
    // Built, waiting for the owner's program: runs nothing, yet keeps its install.
    if (row.status === "choosing")
      return row.installId && readInstall(this.dataDir, row.installId, row.lockDigest)
        ? "choosing"
        : "missing";
    if (row.status !== "ready") return row.status;
    return row.installId && readInstall(this.dataDir, row.installId, row.lockDigest)
      ? "ready"
      : "missing";
  }
  /** Every record by server id: one query for a whole list. */
  byServer() {
    return new Map(this.all().map((row) => [row.serverId, row]));
  }
  /** `rows` (from byServer()) spares a query per server while listing. */
  publicFields(serverId, rows) {
    const row = rows ? (rows.get(serverId) ?? null) : this.get(serverId);
    if (!row) return {};
    const status = this.computedStatus(row);
    return {
      source: {
        registry: row.registry,
        name: row.name,
        version: row.version,
        program: row.program,
        allowScripts: row.allowScripts,
        status,
        errorCode:
          row.errorCode ?? (status === "failed" ? "MCP_PACKAGE_INSTALL_FAILED" : null),
        // No generated argument is stored before the first install.
        leadingArgs: row.installId ? row.leadingArgs : 0,
        constraints: row.constraints,
      },
    };
  }
  definitionFields(serverId, rows) {
    const row = rows ? (rows.get(serverId) ?? null) : this.get(serverId);
    if (!row) return {};
    const status = this.computedStatus(row);
    return {
      packageStatus: status,
      managedDirs:
        status === "ready"
          ? [installDirectory(this.dataDir, row.installId), row.toolchainDir].filter(
              Boolean,
            )
          : [],
    };
  }
}
