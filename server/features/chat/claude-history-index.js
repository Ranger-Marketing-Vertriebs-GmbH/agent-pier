import { claudeConversationRecord } from "./claude-conversation-record.js";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { JsonlHistoryReader, MAX_PAGE_BYTES } from "./jsonl-history-reader.js";
import { problem } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";

const require = createRequire(import.meta.url);
const BLOCK = 64 * 1024;
const mismatch = () => problem(serverMessages.chat.sessionHistoryMismatch, 409);
const tooLarge = () => problem(serverMessages.chat.historyTooLarge, 413);
const same = (a, b) =>
  a &&
  b &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtime === b.mtime;
function parse(bytes, offset) {
  try {
    const record = JSON.parse(bytes.toString("utf8"));
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    if (!record.uuid && !record.message?.id) record.uuid = `claude-byte:${offset}`;
    return claudeConversationRecord(record);
  } catch {
    return null;
  }
}

/** Disposable offset index. Native source bytes are only read, never copied into SQLite. */
export class ClaudeHistoryIndex {
  constructor({ file, directory = os.tmpdir(), onReady, onRecords, onReset }) {
    this.file = file;
    this.onReady = onReady;
    this.onRecords = onRecords;
    this.onReset = onReset;
    this.directory = syncFs.mkdtempSync(path.join(directory, "claude-history-index-"));
    syncFs.chmodSync(this.directory, 0o700);
    this.databasePath = path.join(this.directory, "offsets.sqlite");
    syncFs.closeSync(syncFs.openSync(this.databasePath, "wx", 0o600));
    const { DatabaseSync } = require("node:sqlite");
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec(`PRAGMA journal_mode=MEMORY; PRAGMA cache_size=-2048;
      CREATE TABLE records(offset INTEGER PRIMARY KEY,length INTEGER NOT NULL,group_id TEXT);
      CREATE INDEX record_group ON records(group_id,offset);
      CREATE TABLE groups(id TEXT PRIMARY KEY,first_offset INTEGER NOT NULL,visible INTEGER NOT NULL);
      CREATE INDEX group_order ON groups(first_offset);
      CREATE TABLE calls(id TEXT NOT NULL,group_id TEXT NOT NULL,offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,PRIMARY KEY(id,offset));
      CREATE INDEX call_group ON calls(group_id,offset);
      CREATE TABLE results(id TEXT NOT NULL,group_id TEXT NOT NULL,offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,PRIMARY KEY(id,offset));
      CREATE INDEX result_group ON results(group_id,offset);
    `);
    this.generation = randomUUID();
    this.position = 0;
    this.readBytes = 0;
  }
  ready(identity) {
    return (
      !this.closed &&
      Boolean(this.identity) &&
      identity.dev === this.identity.dev &&
      identity.ino === this.identity.ino &&
      (identity.size < this.identity.size || same(identity, this.identity))
    );
  }
  refresh(identity) {
    if (this.closed) return Promise.reject(mismatch());
    this.target = identity;
    if (this.job) return this.job;
    if (same(identity, this.identity)) return Promise.resolve();
    this.job = (async () => {
      await yieldTurn();
      while (!this.closed && !same(this.target, this.identity)) {
        const target = this.target;
        await this.scan(target);
        this.onReady?.({ identity: this.identity, generation: this.generation });
      }
    })().finally(() => {
      this.job = null;
    });
    return this.job;
  }
  reset() {
    this.db.exec(
      "DELETE FROM records; DELETE FROM groups; DELETE FROM calls; DELETE FROM results;",
    );
    this.identity = null;
    this.position = 0;
    this.generation = randomUUID();
    this.onReset?.();
  }
  async scan(identity) {
    this.scanning = true;
    let reader;
    try {
      if (this.identity) {
        let previous;
        try {
          previous = await JsonlHistoryReader.open(this.file, this.identity);
        } catch {
          this.reset();
        } finally {
          await previous?.close();
        }
      } else this.reset();
      reader = await JsonlHistoryReader.open(this.file, identity);
      let offset = this.position;
      let pending = Buffer.alloc(0);
      for (let position = this.position; position < identity.size;) {
        if (this.closed) throw mismatch();
        const bytes = await reader.bytes(
          position,
          Math.min(BLOCK, identity.size - position),
        );
        this.readBytes += bytes.length;
        position += bytes.length;
        pending = Buffer.concat([pending, bytes]);
        const batch = [];
        this.db.exec("BEGIN");
        try {
          let end;
          while ((end = pending.indexOf(10)) >= 0) {
            const length = end + 1;
            if (length > MAX_PAGE_BYTES) throw tooLarge();
            const record = parse(pending.subarray(0, end), offset);
            if (record) {
              this.insert(record, offset, length);
              batch.push(record);
            }
            pending = pending.subarray(length);
            offset += length;
          }
          if (pending.length > MAX_PAGE_BYTES) throw tooLarge();
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
        this.position = offset;
        if (batch.length) this.onRecords?.(batch);
        await yieldTurn();
      }
      await reader.validate();
      this.identity = identity;
    } catch (error) {
      this.reset();
      throw error;
    } finally {
      await reader?.close();
      this.scanning = false;
    }
  }
  insert(record, offset, length) {
    if (
      !["assistant", "user"].includes(record.type) ||
      record.isMeta ||
      record.isCompactSummary ||
      (record.message?.role && record.message.role !== record.type)
    )
      return;
    const group = String(record.message?.id || record.uuid);
    const content = record.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    const resultEnvelope =
      record.type === "user" && blocks.some((block) => block?.type === "tool_result");
    const visible =
      typeof content === "string"
        ? Boolean(content)
        : blocks.some(
            (block) =>
              (block?.type === "text" && block.text && !resultEnvelope) ||
              (block?.type === "tool_use" && record.type === "assistant"),
          );
    this.db.prepare("INSERT INTO records VALUES (?,?,?)").run(offset, length, group);
    this.db
      .prepare(
        "INSERT INTO groups VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET visible=MAX(visible,excluded.visible)",
      )
      .run(group, offset, Number(visible));
    for (const block of blocks) {
      if (block?.type === "tool_use" && ["string", "number"].includes(typeof block.id))
        this.db
          .prepare("INSERT OR IGNORE INTO calls VALUES (?,?,?,?)")
          .run(String(block.id), group, offset, offset + length);
      if (
        block?.type === "tool_result" &&
        ["string", "number"].includes(typeof block.tool_use_id)
      )
        this.db
          .prepare("INSERT OR IGNORE INTO results VALUES (?,?,?,?)")
          .run(String(block.tool_use_id), group, offset, offset + length);
    }
  }
  async page({
    identity,
    before = Number.MAX_SAFE_INTEGER,
    limit = 50,
    generation,
  } = {}) {
    if (generation && generation !== this.generation) throw mismatch();
    if (!this.ready(identity)) return null;
    const expectedGeneration = this.generation;
    const reader = await JsonlHistoryReader.open(this.file, identity);
    let indexed;
    try {
      indexed = await JsonlHistoryReader.open(this.file, this.identity);
      const groups = this.db
        .prepare(
          `SELECT g.id,g.first_offset FROM groups g
        WHERE g.first_offset<? AND g.first_offset<? AND (g.visible=1 OR EXISTS (
          SELECT 1 FROM results r WHERE r.group_id=g.id AND r.end_offset<=?
          AND NOT EXISTS(SELECT 1 FROM calls c WHERE c.id=r.id AND c.end_offset<=?)
          AND NOT EXISTS(SELECT 1 FROM results prior WHERE prior.id=r.id AND prior.offset<r.offset)
        )) ORDER BY g.first_offset DESC LIMIT ?`,
        )
        .all(
          before,
          identity.size,
          identity.size,
          identity.size,
          Math.min(50, Math.max(1, limit)) + 1,
        );
      const more = groups.length > Math.min(50, Math.max(1, limit));
      if (more) groups.pop();
      const offsets = new Map();
      let selectedBytes = 0;
      const addOffset = (row) => {
        if (offsets.has(row.offset)) return;
        selectedBytes += row.length;
        if (selectedBytes > MAX_PAGE_BYTES || offsets.size >= 10000) throw tooLarge();
        offsets.set(row.offset, row);
      };
      const selected = new Set(groups.map((group) => group.id));
      const tools = new Set();
      for (const group of groups) {
        for (const row of this.db
          .prepare(
            "SELECT offset,length FROM records WHERE group_id=? AND offset+length<=? ORDER BY offset",
          )
          .iterate(group.id, identity.size))
          addOffset(row);
        for (const row of this.db
          .prepare("SELECT DISTINCT id FROM calls WHERE group_id=? AND end_offset<=?")
          .iterate(group.id, identity.size))
          tools.add(row.id);
        for (const row of this.db
          .prepare(
            "SELECT DISTINCT r.id FROM results r WHERE r.group_id=? AND r.end_offset<=? AND NOT EXISTS(SELECT 1 FROM calls c WHERE c.id=r.id AND c.end_offset<=?)",
          )
          .iterate(group.id, identity.size, identity.size))
          tools.add(row.id);
      }
      for (const tool of tools) {
        const row = this.db
          .prepare(
            "SELECT r.offset,s.length FROM results r JOIN records s ON s.offset=r.offset WHERE r.id=? AND r.offset+s.length<=? ORDER BY r.offset DESC LIMIT 1",
          )
          .get(tool, identity.size);
        if (row) addOffset(row);
      }
      const records = [];
      let bytes = 0;
      for (const row of [...offsets.values()].sort((a, b) => a.offset - b.offset)) {
        bytes += row.length;
        if (bytes > MAX_PAGE_BYTES) throw tooLarge();
        const record = parse(await reader.bytes(row.offset, row.length), row.offset);
        if (!record) throw mismatch();
        const resultEnvelope =
          record.type === "user" &&
          Array.isArray(record.message?.content) &&
          record.message.content.some((block) => block?.type === "tool_result");
        if (!selected.has(String(record.message?.id || record.uuid)) || resultEnvelope)
          record.message.content = record.message.content.filter(
            (block) =>
              block?.type === "tool_result" && tools.has(String(block.tool_use_id)),
          );
        if (resultEnvelope && !record.message.content.length) continue;
        records.push(record);
      }
      await reader.validate();
      await indexed.validate();
      if (expectedGeneration !== this.generation) throw mismatch();
      return {
        records,
        nextBefore: more ? groups.at(-1).first_offset : null,
        generation: this.generation,
      };
    } finally {
      await reader.close();
      await indexed?.close();
    }
  }
  async close() {
    if (this.closed) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await this.job?.catch(() => {});
      this.db.close();
      await fs.rm(this.directory, { recursive: true, force: true });
    })();
    return this.closing;
  }
}
