import { createHash } from "node:crypto";
import path from "node:path";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { record } from "../extensions/mcp-config.js";
import { logCraftFailure } from "./craft-log.js";
import {
  killRecordedGroups,
  processTable,
  settleKilledGroups,
} from "./craft-mcp-client.js";
import { rebuildsHome } from "./rebuild-store.js";

const entries = (value) => (record(value) ? Object.entries(value) : []);

/** Command lines are kept only as hashes: a builder's may carry the request text. */
const digest = (command) => createHash("sha256").update(command).digest("hex");

/** `{ pgid: [{ pid, command }] }` with each command replaced by its digest. */
function hashedGroups(groups) {
  return Object.fromEntries(
    entries(groups).map(([pgid, members]) => [
      pgid,
      members.map((member) => ({ pid: member.pid, command: digest(member.command) })),
    ]),
  );
}

/** `{ pgid: [{ pid, command digest }] }` as pgid → pids and pid → command. */
function parsedGroups(saved, groups, commands) {
  for (const [key, members] of entries(saved)) {
    const pgid = Number(key);
    if (!Number.isInteger(pgid) || !Array.isArray(members)) continue;
    for (const member of members) {
      if (!Number.isInteger(member?.pid) || typeof member.command !== "string") continue;
      if (!groups.has(pgid)) groups.set(pgid, new Set());
      groups.get(pgid).add(member.pid);
      commands.set(member.pid, member.command);
    }
  }
}

/**
 * The process groups of the rebuild children and their builders, in
 * `<dataDir>/craft-rebuilds/children.json` (child pid → `{ pgid: [{ pid, command }] }`,
 * each command as its SHA-256 digest), so that a later server can end what a crash or forced exit left running. A child
 * is recorded while it runs and forgotten once it closed cleanly. The entries of the
 * previous server stay in the file until `reap()` ended them.
 */
export class RebuildProcesses {
  constructor(dataDir) {
    this.file = path.join(rebuildsHome(dataDir), "children.json");
    this.live = new Map(); // child pid → its groups (JSON)
    this.stale = {};
    try {
      const saved = readJSON(this.file, null);
      this.stale = record(saved?.children) ? saved.children : {};
    } catch (error) {
      logCraftFailure("read the Craft Anything rebuild processes", error);
    }
  }

  /** `client` (a CraftMcpClient) recorded new process groups. */
  record(client) {
    if (!client.pid) return;
    this.live.set(String(client.pid), hashedGroups(client.processGroups()));
    this.save();
  }

  /** `client` closed: its groups are ended. */
  forget(client) {
    if (!this.live.delete(String(client.pid))) return;
    this.save();
  }

  /**
   * Server start: SIGKILLs every group the previous server recorded that still holds
   * one of its recorded processes with the same command line (a reused pid is left
   * alone; without a process table nothing is ended and the records stay), never a
   * group of this server's own children. Returns the pgids killed.
   */
  async reap() {
    const groups = new Map();
    const commands = new Map();
    for (const [, saved] of entries(this.stale)) parsedGroups(saved, groups, commands);
    if (!groups.size) {
      this.stale = {};
      return [];
    }
    const own = new Set();
    for (const saved of this.live.values())
      for (const key of Object.keys(saved)) own.add(Number(key));
    const listed = await processTable();
    // No process table (ps failed or timed out): keep the records for the next start.
    if (!listed.length) return [];
    this.stale = {};
    const table = listed.map((row) => ({ ...row, command: digest(row.command) }));
    const self = table.find((row) => row.pid === process.pid)?.pgid;
    const killed = killRecordedGroups(table, groups, {
      commands,
      killable: (pgid) =>
        pgid > 1 && pgid !== self && pgid !== process.pid && !own.has(pgid),
    });
    this.save();
    await settleKilledGroups(killed);
    return killed;
  }

  save() {
    try {
      writePrivate(this.file, {
        version: 1,
        children: { ...this.stale, ...Object.fromEntries(this.live) },
      });
    } catch (error) {
      logCraftFailure("save the Craft Anything rebuild processes", error);
    }
  }
}
