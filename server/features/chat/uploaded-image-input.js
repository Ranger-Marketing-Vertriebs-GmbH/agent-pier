import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const MAX_FILES = 64;
const MAX_BYTES = 10 * 1024 * 1024;
const identity = (stat) =>
  [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");

/** Resolve native image fingerprints only against this session's managed uploads. */
export class UploadedImageInput {
  cache = new Map();
  async fingerprint(file) {
    let handle;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > MAX_BYTES) return null;
      const key = identity(stat);
      const cached = this.cache.get(file);
      if (cached?.key === key) return cached.hash;
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      if (identity(await handle.stat()) !== key) return null;
      const bytes = await handle.readFile();
      if (bytes.length > MAX_BYTES || identity(await handle.stat()) !== key) return null;
      const hash = createHash("sha256").update(bytes).digest("hex");
      this.cache.delete(file);
      this.cache.set(file, { key, hash });
      while (this.cache.size > 1024) this.cache.delete(this.cache.keys().next().value);
      return hash;
    } catch {
      return null;
    } finally {
      await handle?.close();
    }
  }
  async paths(directory) {
    const files = [];
    const visit = async (folder, nested = false) => {
      try {
        if (!(await fs.lstat(folder)).isDirectory()) return;
        for (const entry of (await fs.readdir(folder, { withFileTypes: true })).slice(
          0,
          MAX_FILES,
        )) {
          if (files.length >= MAX_FILES) break;
          const file = path.join(folder, entry.name);
          if (entry.isFile()) files.push(file);
          else if (!nested && entry.isDirectory()) await visit(file, true);
        }
      } catch {
        /* Removed/unavailable uploads cannot establish a match. */
      }
    };
    await visit(directory);
    const paths = new Map();
    for (const file of files) {
      const hash = await this.fingerprint(file);
      if (hash) paths.set(hash, [...(paths.get(hash) || []), file]);
    }
    return paths;
  }
  async decorate(session, messages, directory) {
    if (
      session.tool !== "codex" ||
      !directory ||
      !messages.some((message) => message.role === "user" && message.imageInput)
    )
      return messages;
    const paths = await this.paths(directory);
    return messages.map((message) => {
      const input = message.imageInput;
      if (message.role !== "user" || !input) return message;
      return {
        ...message,
        imageInput: {
          text: input.text,
          paths: input.hashes.map((hash) => paths.get(hash) || []),
        },
      };
    });
  }
}
