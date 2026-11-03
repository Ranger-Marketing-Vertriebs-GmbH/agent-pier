import { randomUUID } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import { memoryEntries, withoutEntries } from "./memory-entries.js";
import { NativeMemory, editableNote } from "./native-memory.js";
import {
  hermesEntryDelimiter,
  hermesMemoryChars,
  hermesMemoryLimits,
  runtimeIdOf,
} from "./runtimes/runtime-for.js";

/**
 * AgentPier's archive of memory entries the owner took out of an agent's memory (the
 * memory review after a model switch, memory-review.js). An archived entry is kept
 * verbatim in AgentPier's database, which the agent never reads: not in its context,
 * its memory search or dreaming. Private (operations/private-tables.js) and removed
 * with the agent (agent-deletion.js).
 */
export const memoryArchiveTable =
  "CREATE TABLE IF NOT EXISTS assistant_memory_archive (id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, body TEXT NOT NULL)";

const rootFiles = new Set(["MEMORY.md", "USER.md"]);
const longest = 200;

export class MemoryArchive {
  constructor(db, now = () => new Date().toISOString()) {
    Object.assign(this, { db, now });
    db.exec(memoryArchiveTable);
  }
  /** The archived entries of an agent, newest first: `{ id, file, text, ... }`. */
  list(assistantId) {
    return this.db
      .prepare(
        "SELECT id, body FROM assistant_memory_archive WHERE assistant_id=? ORDER BY rowid DESC",
      )
      .all(assistantId)
      .map((row) => ({ id: row.id, ...JSON.parse(row.body) }));
  }
  get(assistantId, id) {
    const row = this.db
      .prepare("SELECT body FROM assistant_memory_archive WHERE assistant_id=? AND id=?")
      .get(assistantId, id);
    return row ? { id, ...JSON.parse(row.body) } : null;
  }
  /**
   * Keeps `entries` (`[{ file, text }]`) with `meta` (`{ switch, reviewId }`) in one
   * transaction; returns the new rows' ids.
   */
  archive(assistantId, entries, meta) {
    const archivedAt = this.now();
    const ids = entries.map(() => randomUUID());
    const insert = this.db.prepare("INSERT INTO assistant_memory_archive VALUES(?,?,?)");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      entries.forEach(({ file, text }, i) =>
        insert.run(
          ids[i],
          assistantId,
          JSON.stringify({
            file,
            text,
            archivedAt,
            switch: meta.switch,
            reviewId: meta.reviewId,
          }),
        ),
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return ids;
  }
  /** Drops archived rows: a restored entry, or rows whose file write failed. */
  restore(assistantId, ...ids) {
    const remove = this.db.prepare(
      "DELETE FROM assistant_memory_archive WHERE assistant_id=? AND id=?",
    );
    for (const id of ids) remove.run(assistantId, id);
  }
}

// One archive per database, made on first use (the service has no room for it).
const archives = new WeakMap();
export function memoryArchiveOf(service) {
  const db = service.store.db;
  if (!archives.has(db)) archives.set(db, new MemoryArchive(db));
  return archives.get(db);
}
const memoryOf = (service) => service.nativeMemory ?? new NativeMemory(service);
const gone = { content: "", missing: true, hash: null };
// A file as read; a note that is gone reads as missing, as a missing root file does.
const readFile = (memory, assistantId, name) =>
  memory.read(assistantId, name).catch((error) => {
    if (error.status === 404 && !rootFiles.has(name)) return gone;
    throw error;
  });

function checkedMeta(meta) {
  const name = (value) =>
    typeof value === "string" && value.trim() && value.trim().length <= longest
      ? value.trim()
      : null;
  const from = name(meta?.switch?.from),
    to = name(meta?.switch?.to);
  return {
    switch: from && to ? { from, to } : null,
    reviewId: name(meta?.reviewId),
  };
}
function checkedEntries(entries, runtime) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 500)
    throw assistantProblem("invalid");
  for (const { file, entry } of entries)
    if (
      !(rootFiles.has(file) || (runtime !== "hermes" && editableNote(file))) ||
      typeof entry !== "string" ||
      !entry.trim()
    )
      throw assistantProblem("invalid");
  return Map.groupBy(entries, (e) => e.file);
}

// A root file goes through the runtime (Gateway or Hermes), a note to the workspace.
function writeFile(memory, assistantId, name, content, hash) {
  if (!rootFiles.has(name))
    return memory.writeNote(assistantId, { name, content, expectedHash: hash });
  return memory.write(assistantId, {
    name,
    content,
    ...(hash ? { expectedHash: hash } : { expectedMissing: true }),
  });
}

function audit(service, assistantId, verb, count, files) {
  try {
    service.audit?.append({
      action: `assistant.${verb}`,
      resourceType: "assistant",
      resourceId: assistantId,
      outcome: "success",
      source: "user",
      details: { count, files },
    });
  } catch (error) {
    console.error("Memory archive audit failed:", error?.message);
  }
}

/**
 * Moves the owner's chosen `entries` (`[{ file, entry }]`, the memory review's
 * entries, memory-review-answer.js) of agent `assistantId` out of its memory files
 * into the archive, with `meta` `{ switch: { from, to }, reviewId }`. Returns `{
 * archived, changed }`: `changed` lists the entry texts no longer in their file as
 * read, or whose file changed before the write (409); they stay where they are.
 *
 * Per file: read with its hash, compute the file without the entries, insert their
 * archive rows (one committed transaction), then write the file against the hash. A
 * failed write deletes the just-inserted rows again, so archive and file never
 * disagree; a crash between the two leaves an entry in both, never in neither.
 *
 * Takes no admission itself: each read and write goes through NativeMemory's public
 * methods, which take it (call it from a request handler, never inside admit()).
 * Dreaming's corpus is left alone (docs/agents.md "Memory").
 */
export async function archiveEntries(service, assistantId, entries, meta) {
  const agent = service.store.getAssistant(assistantId);
  const runtime = runtimeIdOf(agent);
  const byFile = checkedEntries(entries, runtime);
  const details = checkedMeta(meta);
  const memory = memoryOf(service);
  const archive = memoryArchiveOf(service);
  const changed = [];
  const files = [];
  let archived = 0;
  try {
    for (const [file, items] of byFile) {
      const read = await readFile(memory, assistantId, file);
      const present = new Set(
        read.missing ? [] : memoryEntries(runtime, file, read.content).map((e) => e.text),
      );
      const texts = [...new Set(items.map((item) => item.entry))];
      const found = texts.filter((text) => present.has(text));
      changed.push(...texts.filter((text) => !present.has(text)));
      if (!found.length) continue;
      // Without a hash the write could not detect a change: the entries stay.
      if (!read.hash) {
        changed.push(...found);
        continue;
      }
      const content = withoutEntries(runtime, file, read.content, found);
      const ids = archive.archive(
        assistantId,
        found.map((text) => ({ file, text })),
        details,
      );
      try {
        await writeFile(memory, assistantId, file, content, read.hash);
      } catch (error) {
        archive.restore(assistantId, ...ids);
        if (error.status !== 409) throw error;
        changed.push(...found);
        continue;
      }
      archived += found.length;
      files.push(file);
    }
  } finally {
    if (archived) audit(service, assistantId, "memory-archived", archived, files);
  }
  return { archived, changed };
}

// The file's content with `text` appended as its last entry.
function appended(runtime, content, text) {
  if (runtime === "hermes")
    return memoryEntries(runtime, "", content).length
      ? `${content}${hermesEntryDelimiter}${text}`
      : text;
  if (!content) return `- ${text}\n`;
  return content.endsWith("\n") ? `${content}- ${text}\n` : `${content}\n- ${text}`;
}

/**
 * Puts archived entry `archiveId` of agent `assistantId` back at the end of its file
 * (an OpenClaw list item, a Hermes block within Hermes's limit: 409 otherwise) and
 * drops it from the archive once the file is written: `{ restored: true, file }`.
 * 404 for an unknown entry, 409 when the file changed between read and write or a
 * note is gone. Takes no admission itself, as archiveEntries.
 */
export async function restoreEntry(service, assistantId, archiveId) {
  const agent = service.store.getAssistant(assistantId);
  const archive = memoryArchiveOf(service);
  const entry =
    typeof archiveId === "string" ? archive.get(assistantId, archiveId) : null;
  if (!entry) throw assistantProblem("notFound", 404);
  const runtime = runtimeIdOf(agent);
  const memory = memoryOf(service);
  const read = await readFile(memory, assistantId, entry.file);
  // A note is never created again, and a root file is written against its hash.
  if ((read.missing && !rootFiles.has(entry.file)) || (!read.missing && !read.hash))
    throw assistantProblem("conflict", 409);
  const content = appended(runtime, read.missing ? "" : read.content, entry.text);
  const limit = hermesMemoryLimits[entry.file];
  if (runtime === "hermes" && hermesMemoryChars(content) > limit)
    throw assistantProblem("memoryTooLarge", 409, entry.file, limit);
  await writeFile(memory, assistantId, entry.file, content, read.hash);
  archive.restore(assistantId, archiveId);
  audit(service, assistantId, "memory-restored", 1, [entry.file]);
  return { restored: true, file: entry.file };
}

/** The archive as the memory page shows it: `{ entries: [{ id, file, text, ... }] }`. */
export function archivedEntries(service, assistantId) {
  service.store.getAssistant(assistantId);
  return {
    entries: memoryArchiveOf(service)
      .list(assistantId)
      .map(({ id, file, text, archivedAt, switch: from }) => ({
        id,
        file,
        text,
        archivedAt,
        switch: from,
      })),
  };
}
