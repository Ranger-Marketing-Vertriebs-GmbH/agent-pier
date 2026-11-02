import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// A synthetic OpenClaw auth profile store in OpenClaw 2026.10.9's layouts (the native
// contract assistant-chatgpt-access-contract pins them on the real runtime): the
// state database's machine state, or the main agent's own database. Returns `{
// stateDir, read }`; `read()` parses the store row.
export function openClawStore(t, { layout = "state-db", store, owner } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-store-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(stateDir, "state"));
  const shared = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
  shared.exec(
    "CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT",
  );
  const put = (db, sql, ...values) => db.prepare(sql).run(...values);
  if (layout === "state-db" || owner)
    put(
      shared,
      "INSERT INTO config_machine_state VALUES (?, ?, 1)",
      "auth.sharedStore",
      JSON.stringify(owner ?? { location: "state-db" }),
    );
  let agent = null;
  if (layout === "state-db" && store)
    put(
      shared,
      "INSERT INTO config_machine_state VALUES (?, ?, 1)",
      "authProfiles.store",
      JSON.stringify(store),
    );
  if (layout === "legacy-main") {
    const dir = path.join(stateDir, "agents", "main", "agent");
    fs.mkdirSync(dir, { recursive: true });
    agent = new DatabaseSync(path.join(dir, "openclaw-agent.sqlite"));
    agent.exec(
      "CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT",
    );
    if (store)
      put(
        agent,
        "INSERT INTO auth_profile_store VALUES ('primary', ?, 1)",
        JSON.stringify(store),
      );
  }
  shared.close();
  agent?.close();
  const read = () => {
    const db =
      layout === "legacy-main"
        ? new DatabaseSync(
            path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
          )
        : new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
    try {
      const row =
        layout === "legacy-main"
          ? db.prepare("SELECT store_json AS j FROM auth_profile_store").get()
          : db
              .prepare(
                "SELECT value_json AS j FROM config_machine_state WHERE state_key = ?",
              )
              .get("authProfiles.store");
      return row && JSON.parse(row.j);
    } finally {
      db.close();
    }
  };
  const ownerOf = () => {
    const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
    try {
      const row = db
        .prepare("SELECT value_json AS j FROM config_machine_state WHERE state_key = ?")
        .get("auth.sharedStore");
      return row && JSON.parse(row.j);
    } finally {
      db.close();
    }
  };
  return { stateDir, read, owner: ownerOf };
}
