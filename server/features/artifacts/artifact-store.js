import { validateArtifactState } from "./artifact-metadata.js";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readJSON, privateDirectory } from "../../lib/storage.js";
export class ArtifactStore {
  constructor(dataDir) {
    this.root = path.join(dataDir, "artifacts");
    this.generations = path.join(this.root, "generations");
    privateDirectory(this.generations);
    this.file = path.join(this.root, "index.json");
    this.state = readJSON(this.file, {
      version: 1,
      records: {},
      receipts: {},
      retired: [],
    });
    this.state = validateArtifactState(this.state);
  }
  save(next) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = syncFs.openSync(temporary, "wx", 0o600);
      syncFs.writeFileSync(fd, JSON.stringify(next, null, 2) + "\n");
      syncFs.fsyncSync(fd);
      syncFs.closeSync(fd);
      fd = undefined;
      syncFs.renameSync(temporary, this.file);
      this.state = next;
      fd = syncFs.openSync(this.root, "r");
      syncFs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) syncFs.closeSync(fd);
      syncFs.rmSync(temporary, { force: true });
    }
  }
  async syncGeneration(folder) {
    for (const directory of [
      folder,
      this.generations,
      this.root,
      path.dirname(this.root),
    ]) {
      const handle = await fs.open(directory, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
  async usage() {
    let usedBytes = 0,
      pendingCleanupBytes = 0;
    const live = new Set(
      Object.values(this.state.records)
        .filter((r) => !r.deleted)
        .map((r) => r.generation),
    );
    for (const entry of await fs.readdir(this.generations, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const name of await fs.readdir(path.join(this.generations, entry.name))) {
        const stat = await fs.lstat(path.join(this.generations, entry.name, name));
        usedBytes += stat.size;
        if (!live.has(entry.name)) pendingCleanupBytes += stat.size;
      }
    }
    usedBytes += (await fs.stat(this.file).catch(() => ({ size: 0 }))).size;
    return { usedBytes, pendingCleanupBytes };
  }
  async cleanup(onError) {
    const directory = await fs.open(this.root, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    const live = new Set(
      Object.values(this.state.records)
        .filter((r) => !r.deleted)
        .map((r) => r.generation),
    );
    for (const entry of await fs.readdir(this.generations)) {
      if (live.has(entry)) continue;
      await fs
        .rm(path.join(this.generations, entry), { recursive: true, force: true })
        .catch(onError);
    }
  }
}
