/**
 * The rows a public configuration copy of an agent database keeps (docs/backups.md).
 * Each function edits a copy in place; the caller vacuums it afterwards, so removed
 * rows survive in no free page. The full copy is sealed with history.
 */

// AgentPier's agent databases (assistants.sqlite, channels.sqlite): conversations,
// requests and their attempts, cached messages, attachment and share indexes, queued
// messages, routine results, memory notes, hidden long-chat hints, leads' long-chat
// notes, action history and Telegram messages.
const agentPierPrivateTables = [
  "agent_attachments",
  "assistant_actions",
  "assistant_long_chat_dismissals",
  "assistant_member_long_chats",
  "assistant_memory_notes",
  "assistant_routine_events",
  "assistant_routine_results",
  "attempt_reviews",
  "attempts",
  "channel_inbox",
  "channel_outbox",
  "channel_strangers",
  "messages",
  "queued_messages",
  "requests",
  "conversations",
];
// Team records: policy and settings are configuration; teams, members, request
// contexts and lead requests are task history.
const teamConfiguration = ["policy", "settings"];

const tableNames = (db) =>
  db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='table'")
    .all()
    .filter((row) => !row.name.startsWith("sqlite_"));
const quote = (name) => `"${name.replaceAll('"', '""')}"`;

/**
 * Removes the private rows from AgentPier's database copy `db`, keeping
 * configuration. Returns whether the database has private tables at all.
 */
export function stripPrivateRows(db) {
  const tables = new Set(tableNames(db).map((row) => row.name));
  const present = agentPierPrivateTables.filter((table) => tables.has(table));
  const teams = tables.has("assistant_team_records");
  if (!present.length && !teams) return false;
  db.exec("PRAGMA foreign_keys=OFF");
  for (const table of present) db.exec(`DELETE FROM ${quote(table)}`);
  if (teams)
    db.prepare(
      `DELETE FROM assistant_team_records WHERE kind NOT IN (${teamConfiguration
        .map(() => "?")
        .join(",")})`,
    ).run(...teamConfiguration);
  return true;
}

/**
 * OpenClaw's configuration tables (2026.10, global openclaw.sqlite and per-agent
 * openclaw-agent.sqlite): logins, secrets, approvals, schedules, device and pairing
 * identity, projects, plugin state, preferences and migration bookkeeping. Every
 * other table, including any a later OpenClaw adds, is private: its rows travel
 * only in the sealed full copy. Credential tables among these are emptied before
 * (backup-credentials.js) and come back from their sealed sidecar.
 */
export const openClawConfigurationTables = new Set([
  "agent_databases",
  "agent_provenance",
  "auth_profile_state",
  "auth_profile_store",
  "channel_pairing_allow_entries",
  "claw_installs",
  "claw_mcp_server_refs",
  "claw_package_refs",
  "config_health_entries",
  "config_machine_state",
  "config_revision_keys",
  "cron_jobs",
  "device_auth_tokens",
  "device_bootstrap_tokens",
  "device_identities",
  "device_pairing_paired",
  "exec_approvals_config",
  "gateway_origin_device_tokens",
  "mcp_oauth_pending_authorizations",
  "mcp_oauth_stores",
  "migration_runs",
  "migration_sources",
  "operator_approvals",
  "plugin_binding_approvals",
  "plugin_state_entries",
  "projects",
  "schema_meta",
  "secret_store_entries",
  "user_preferences",
  "web_push_subscriptions",
  "worker_environment_credentials",
  "worker_environments",
  "workspace_setup_state",
  "worktree_templates",
]);

/** Empties virtual table `name` (full-text or vector index) through its module. */
function emptyVirtual(db, name) {
  for (const statement of [
    `DELETE FROM ${quote(name)}`,
    // External-content and contentless FTS5 tables refuse DELETE.
    `INSERT INTO ${quote(name)}(${quote(name)}) VALUES('delete-all')`,
  ])
    try {
      db.exec(statement);
      return true;
    } catch {
      // Try the next way.
    }
  return false;
}

/**
 * Removes every row of OpenClaw's database copy `db` outside the configuration
 * tables; the schema stays. Returns true: OpenClaw's databases are always split.
 */
export function stripOpenClawRows(db) {
  const tables = tableNames(db);
  const virtual = tables.filter((row) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql));
  // A virtual table keeps its rows in shadow tables named after it.
  const shadowOf = (name) =>
    virtual.find((row) => row.name !== name && name.startsWith(`${row.name}_`));
  db.exec("PRAGMA foreign_keys=OFF");
  const unhandled = new Set();
  for (const { name } of virtual)
    if (!openClawConfigurationTables.has(name) && !emptyVirtual(db, name))
      unhandled.add(name);
  for (const { name } of tables) {
    if (openClawConfigurationTables.has(name)) continue;
    if (virtual.some((row) => row.name === name)) continue;
    const owner = shadowOf(name);
    // Shadow tables of an emptied index keep their bookkeeping; those of an index
    // this host cannot open (a module it lacks) lose their rows all the same.
    if (owner && !unhandled.has(owner.name)) continue;
    if (owner && openClawConfigurationTables.has(owner.name)) continue;
    db.exec(`DELETE FROM ${quote(name)}`);
  }
  return true;
}
