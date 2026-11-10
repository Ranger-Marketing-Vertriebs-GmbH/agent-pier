import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { rasterType } from "../chat/chat-image-probe.js";
import { logCraftFailure } from "./craft-log.js";
import { MAX_PICTURE_PIXELS, pictureSize } from "./picture-size.js";
import { rebuildsHome } from "./rebuild-store.js";

const messages = serverMessages.craft;

/**
 * What pictures of the original may be: at most `count` per start or follow-up, each
 * at most `maxBytes` (Craft Anything 0.6.0 refuses a picture over 20 MB), at most
 * at most `pixels` (picture-size.js), at most `held` waiting at once for all callers
 * together, each for at most `ttlMs`, swept every `sweepMs`.
 */
export const pictureLimits = Object.freeze({
  count: 10,
  maxBytes: 20 * 1024 * 1024,
  pixels: MAX_PICTURE_PIXELS,
  held: 40,
  ttlMs: 60 * 60 * 1000,
  sweepMs: 60 * 1000,
});

// The formats Craft Anything 0.6.0 copies (workspace.rs copy_pictures: by extension),
// by their bytes (rasterType); AVIF is a raster image it skips.
const extensions = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const idPattern = /^[a-f0-9]{32}$/;

/** A list of staged picture ids (absent: none), or a 400. */
export function cleanPictureIds(value) {
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    value.length > pictureLimits.count ||
    value.some((id) => typeof id !== "string" || !idPattern.test(id)) ||
    new Set(value).size !== value.length
  )
    throw problem(messages.rebuildPicturesInvalid, 400);
  return value;
}

/** The picture's type by its bytes when Craft Anything takes it, else null. */
export function pictureType(body) {
  const type = Buffer.isBuffer(body) ? rasterType(body) : null;
  return Object.hasOwn(extensions, type ?? "") ? type : null;
}

/**
 * Pictures waiting for rebuild_start in `<dataDir>/craft-rebuilds/pictures` (0700,
 * each file 0600, named `<id>.<ext>` by its sniffed type, since Craft Anything picks
 * pictures by their extension). Every caller hands bytes it has already read and
 * checked: the owner's upload, or a file a session or an agent may read (copied by
 * the caller, never named by path here). Craft Anything copies a start's pictures
 * into the project's reference/ folder before rebuild_start answers; the staged
 * copies go then, when the owner's form drops them (`release`), after `ttlMs` unused
 * (a timer sweeps while `start` runs it), and at every server start and stop.
 */
export class RebuildPictures {
  constructor({ dataDir, now = Date.now, limits = pictureLimits }) {
    this.dir = path.join(rebuildsHome(dataDir), "pictures");
    this.now = now;
    this.limits = limits;
    this.entries = new Map();
    this.timer = null;
  }

  /** Sweeps every `sweepMs`, without keeping the process alive. */
  start() {
    this.timer ??= setInterval(() => this.sweep(), this.limits.sweepMs);
    this.timer.unref?.();
  }

  /** Stops the sweep. */
  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Removes every staged picture, also what an earlier process left. */
  clear() {
    this.entries.clear();
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch (error) {
      logCraftFailure("remove the waiting rebuild pictures", error);
    }
  }

  /** Stages a picture's bytes: `{ id, type, bytes }`, or a 400, 413 or 429. */
  async stage(body) {
    if (!Buffer.isBuffer(body) || !body.length)
      throw problem(messages.rebuildPictureEmpty, 400);
    if (body.length > this.limits.maxBytes)
      throw problem(messages.rebuildPictureTooLarge, 413);
    const type = pictureType(body);
    const size = type && pictureSize(body, type);
    if (!size || !size.width || !size.height)
      throw problem(messages.rebuildPictureType, 400);
    if (size.width * size.height > this.limits.pixels)
      throw problem(messages.rebuildPictureTooManyPixels, 413);
    this.sweep();
    if (this.entries.size >= this.limits.held)
      throw problem(messages.rebuildPicturesBusy, 429);
    const id = randomBytes(16).toString("hex");
    const file = path.join(this.dir, `${id}.${extensions[type]}`);
    // Reserved before the write, so concurrent uploads keep to `held`.
    this.entries.set(id, { file, at: this.now() });
    try {
      await fs.promises.mkdir(this.dir, { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(file, body, { flag: "wx", mode: 0o600 });
    } catch (error) {
      this.release([id]);
      throw error;
    }
    return { id, type, bytes: body.length };
  }

  /**
   * Takes staged pictures (`ids` from cleanPictureIds) for one rebuild_start: their
   * absolute paths in order, no longer released by anyone else (a retry that joins
   * this start, the sweep); `discard` removes them once Craft Anything has copied them.
   * A 400 when one is no longer waiting, and then nothing is taken.
   */
  take(ids) {
    this.sweep();
    const files = ids.map((id) => {
      const entry = this.entries.get(id);
      if (!entry) throw problem(messages.rebuildPictureGone, 400);
      return entry.file;
    });
    for (const id of ids) this.entries.delete(id);
    return files;
  }

  /** Removes taken pictures (`take`'s paths). */
  discard(files) {
    for (const file of files)
      try {
        fs.rmSync(file, { force: true });
      } catch (error) {
        logCraftFailure("remove a rebuild picture", error);
      }
  }

  /** Removes these staged pictures; taken ones and anything else are ignored. */
  release(ids) {
    if (!Array.isArray(ids)) return;
    const files = [];
    for (const id of ids) {
      const entry = typeof id === "string" ? this.entries.get(id) : null;
      if (!entry) continue;
      this.entries.delete(id);
      files.push(entry.file);
    }
    this.discard(files);
  }

  /** Removes the pictures that waited longer than `ttlMs`. */
  sweep() {
    const oldest = this.now() - this.limits.ttlMs;
    this.release(
      [...this.entries].filter(([, entry]) => entry.at < oldest).map(([id]) => id),
    );
  }
}
