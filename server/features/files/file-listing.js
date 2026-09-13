import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileProblem, fileSystemProblem } from "./file-errors.js";
import { resolveFile } from "./file-paths.js";
import { projectFileEntry } from "./file-reading.js";

const snapshotTtlMs = 30_000;
const snapshotCapacity = 8;
const sorts = new Set(["name", "type", "size", "modifiedAt"]);
const directions = new Set(["asc", "desc"]);

function validateQuery({ path: selectedPath, page, sort, direction, hidden, snapshot }) {
  if (!Number.isSafeInteger(page) || page < 1)
    throw fileProblem("FILE_INVALID_PAGE", 400);
  if (!sorts.has(sort) || !directions.has(direction) || typeof hidden !== "boolean")
    throw fileProblem("FILE_INVALID_SORT", 400);
  if (snapshot !== null && typeof snapshot !== "string")
    throw fileProblem("FILE_SNAPSHOT_EXPIRED", 409);
  return JSON.stringify([selectedPath, sort, direction, hidden]);
}

function compareValues(left, right) {
  if (left === right) return 0;
  if (typeof left === "string") return left.localeCompare(right);
  return left < right ? -1 : 1;
}

function sortEntries(entries, sort, direction) {
  const factor = direction === "asc" ? 1 : -1;
  entries.sort((left, right) => {
    const directoryOrder =
      Number(right.type === "directory") - Number(left.type === "directory");
    if (directoryOrder) return directoryOrder;
    if (left[sort] === null && right[sort] !== null) return 1;
    if (right[sort] === null && left[sort] !== null) return -1;
    const primary = compareValues(left[sort], right[sort]);
    if (primary) return primary * factor;
    return left.name.localeCompare(right.name) * factor;
  });
}

function parentPath(scope, selectedPath) {
  if (scope.kind === "project") {
    if (!selectedPath) return null;
    const parent = path.posix.dirname(selectedPath);
    return parent === "." ? "" : parent;
  }
  if (selectedPath === "/") return null;
  return path.dirname(selectedPath);
}

function childPath(scope, parent, name) {
  if (scope.kind === "project") return parent ? `${parent}/${name}` : name;
  return path.join(parent, name);
}

export class FileListingStore {
  constructor({ limits, now = Date.now }) {
    this.limits = limits;
    this.now = now;
    this.snapshots = new Map();
  }

  #expired(snapshot, now) {
    return snapshot.state === "ready" && now - snapshot.createdAt >= snapshotTtlMs;
  }

  #removeExpired(now) {
    for (const [id, snapshot] of this.snapshots)
      if (!snapshot.pins && this.#expired(snapshot, now)) this.snapshots.delete(id);
  }

  #reserve(scopeId, queryKey) {
    const now = this.now();
    this.#removeExpired(now);
    if (this.snapshots.size >= snapshotCapacity) {
      const candidate = [...this.snapshots.values()]
        .filter((snapshot) => !snapshot.pins && snapshot.state === "ready")
        .sort((left, right) => left.lastUsed - right.lastUsed)[0];
      if (!candidate)
        throw fileProblem("FILE_LIMIT_EXCEEDED", 413, { limit: snapshotCapacity });
      this.snapshots.delete(candidate.id);
    }
    const snapshot = {
      id: randomUUID(),
      scopeId,
      queryKey,
      createdAt: now,
      lastUsed: now,
      pins: 1,
      state: "building",
      value: null,
    };
    this.snapshots.set(snapshot.id, snapshot);
    return snapshot;
  }

  #acquire(scopeId, queryKey, id) {
    const snapshot = this.snapshots.get(id);
    const now = this.now();
    if (
      !snapshot ||
      snapshot.scopeId !== scopeId ||
      snapshot.queryKey !== queryKey ||
      snapshot.state !== "ready" ||
      this.#expired(snapshot, now)
    ) {
      if (snapshot && !snapshot.pins && this.#expired(snapshot, now))
        this.snapshots.delete(snapshot.id);
      throw fileProblem("FILE_SNAPSHOT_EXPIRED", 409);
    }
    snapshot.pins += 1;
    snapshot.lastUsed = now;
    return snapshot;
  }

  async #build(scope, queryKey, selectedPath, sort, direction, hidden) {
    const snapshot = this.#reserve(scope.id, queryKey);
    try {
      const resolved = await resolveFile(scope, selectedPath);
      if (!resolved.stat.isDirectory()) throw fileProblem("FILE_NOT_DIRECTORY", 400);
      const names = [];
      const directory = await fs.opendir(resolved.absolute);
      try {
        for await (const entry of directory) {
          if (!hidden && entry.name.startsWith(".")) continue;
          if (names.length === this.limits.listEntries)
            throw fileProblem("FILE_LIMIT_EXCEEDED", 413, {
              limit: this.limits.listEntries,
            });
          names.push(entry.name);
        }
      } finally {
        await directory.close().catch((error) => {
          if (error.code !== "ERR_DIR_CLOSED") throw error;
        });
      }
      const entries = [];
      for (const name of names) {
        const child = await resolveFile(scope, childPath(scope, resolved.path, name), {
          followLeaf: false,
        });
        entries.push(await projectFileEntry(scope, child));
      }
      sortEntries(entries, sort, direction);
      snapshot.value = {
        path: resolved.path,
        parent: parentPath(scope, resolved.path),
        entries,
      };
      snapshot.state = "ready";
      return snapshot;
    } catch (error) {
      this.snapshots.delete(snapshot.id);
      throw fileSystemProblem(error);
    }
  }

  async list(
    scope,
    {
      path: selectedPath,
      page = 1,
      sort = "name",
      direction = "asc",
      hidden = false,
      snapshot = null,
    },
  ) {
    const queryKey = validateQuery({
      path: selectedPath,
      page,
      sort,
      direction,
      hidden,
      snapshot,
    });
    const held =
      snapshot !== null
        ? this.#acquire(scope.id, queryKey, snapshot)
        : await this.#build(scope, queryKey, selectedPath, sort, direction, hidden);
    try {
      const offset = (page - 1) * this.limits.listPageSize;
      const entries = held.value.entries.slice(offset, offset + this.limits.listPageSize);
      return {
        path: held.value.path,
        parent: held.value.parent,
        entries,
        total: held.value.entries.length,
        page,
        pageSize: this.limits.listPageSize,
        hasMore: offset + entries.length < held.value.entries.length,
        snapshotId: held.id,
      };
    } finally {
      held.pins -= 1;
      held.lastUsed = this.now();
    }
  }
}
