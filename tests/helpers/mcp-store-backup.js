import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadArchive } from "./backup-archive.js";

export const backupPassphrase = "mcp server backup fixture phrase";

/** Rows of `sql` in a SQLite file, as plain objects. */
export function rows(file, sql) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}
export { archiveText } from "./backup-archive.js";
/** The archive's public MCP server store, written to `folder` for inspection. */
export function publicStore(file, folder) {
  const member = loadArchive(file).files.find(
    (m) => m.path === "mcp-servers/servers.sqlite",
  );
  const copy = path.join(folder, `public-${Date.now()}-${Math.random()}.sqlite`);
  fs.writeFileSync(copy, Buffer.from(member.content, "base64"));
  return copy;
}
/** Table name → column names of a SQLite file, without SQLite's own tables. */
export function schema(file) {
  const out = {};
  for (const { name } of rows(
    file,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ))
    out[name] = rows(file, `PRAGMA table_info(${name})`).map((c) => c.name);
  return out;
}
