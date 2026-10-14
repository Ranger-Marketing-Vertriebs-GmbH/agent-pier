import { installDirectory, readInstall } from "./package-store.js";

const schema = `
CREATE TABLE IF NOT EXISTS server_packages(
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  registry TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL,
  program TEXT NOT NULL, program_path TEXT NOT NULL, allow_scripts INTEGER NOT NULL DEFAULT 0,
  lock TEXT NOT NULL, lock_digest TEXT NOT NULL, integrity TEXT NOT NULL,
  install_id TEXT, leading_args INTEGER NOT NULL DEFAULT 0, toolchain_dir TEXT,
  status TEXT NOT NULL CHECK(status IN ('installing','ready','failed')),
  error_code TEXT, updated_at INTEGER NOT NULL);`;
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
};
const fromRow = (row) =>
  row && {
    serverId: row.server_id,
    ...Object.fromEntries(
      Object.entries(columns).map(([key, column]) => [key, row[column]]),
    ),
    allowScripts: row.allow_scripts === 1,
    updatedAt: row.updated_at,
  };
const toValue = (key, value) =>
  key === "allowScripts" ? (value ? 1 : 0) : (value ?? null);

/** One package source per server, beside the servers it belongs to (and backed up with them). */
export class PackageRecords {
  constructor(db, dataDir) {
    Object.assign(this, { db, dataDir });
    db.exec(schema);
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
    if (row.status !== "ready") return row.status;
    return row.installId && readInstall(this.dataDir, row.installId, row.lockDigest)
      ? "ready"
      : "missing";
  }
  publicFields(serverId) {
    const row = this.get(serverId);
    if (!row) return {};
    return {
      source: {
        registry: row.registry,
        name: row.name,
        version: row.version,
        program: row.program,
        allowScripts: row.allowScripts,
        status: this.computedStatus(row),
        errorCode: row.errorCode,
        // No generated argument is stored before the first install.
        leadingArgs: row.installId ? row.leadingArgs : 0,
      },
    };
  }
  definitionFields(serverId) {
    const row = this.get(serverId);
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
