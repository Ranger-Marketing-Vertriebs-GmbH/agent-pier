import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { reduceNativeEvent } from "./native-events.js";

export class NativeEventReader {
  constructor(dataDir) {
    this.directory = path.join(dataDir, "sessions");
    this.cache = new Map();
  }
  async receipt(id) {
    let file;
    try {
      file = await fs.open(
        path.join(this.directory, `${id}.outcome.json`),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > 4096 ||
        (process.getuid && info.uid !== process.getuid())
      )
        return null;
      const value = JSON.parse(await file.readFile("utf8"));
      return value?.groupStopped === true &&
        Number.isInteger(value.exitCode) &&
        value.exitCode >= 0 &&
        value.exitCode <= 255
        ? value
        : null;
    } finally {
      await file.close();
    }
  }
  async read(id, tool) {
    let file;
    try {
      file = await fs.open(
        path.join(this.directory, `${id}.events.jsonl`),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        (process.getuid && info.uid !== process.getuid()) ||
        info.size > 64 * 1024 * 1024
      )
        throw Error("Invalid native observation file.");
      let cache = this.cache.get(id);
      if (!cache || cache.ino !== info.ino || info.size < cache.offset)
        cache = {
          ino: info.ino,
          offset: 0,
          pending: "",
          decoder: new StringDecoder("utf8"),
          state: {},
        };
      const previousOffset = cache.offset,
        buffer = Buffer.alloc(64 * 1024);
      while (cache.offset < info.size) {
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, info.size - cache.offset),
          cache.offset,
        );
        if (!bytesRead) break;
        cache.offset += bytesRead;
        cache.pending += cache.decoder.write(buffer.subarray(0, bytesRead));
        let end;
        while ((end = cache.pending.indexOf("\n")) !== -1) {
          const line = cache.pending.slice(0, end);
          cache.pending = cache.pending.slice(end + 1);
          if (line.length > 1024 * 1024)
            throw Error("Native event exceeds the observation limit.");
          if (line.trim()) {
            let event;
            try {
              event = JSON.parse(line);
            } catch {
              throw Error("Native CLI emitted invalid JSONL.");
            }
            cache.state = reduceNativeEvent(tool, cache.state, event);
          }
        }
        if (cache.pending.length > 1024 * 1024)
          throw Error("Native event exceeds the observation limit.");
      }
      this.cache.delete(id);
      if (cache.offset > previousOffset)
        cache.lastActivityAt = new Date(info.mtimeMs).toISOString();
      this.cache.set(id, cache);
      while (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value);
      return {
        ...cache.state,
        lastActivityAt: cache.lastActivityAt,
        incomplete: Boolean(cache.pending.trim()),
      };
    } catch (error) {
      this.cache.delete(id);
      throw error;
    } finally {
      await file.close();
    }
  }
}
