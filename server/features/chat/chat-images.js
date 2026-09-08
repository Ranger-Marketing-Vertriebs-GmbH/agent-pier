import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { problem } from "../../lib/storage.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const imageExtension = /\.(?:png|jpe?g|gif|webp|avif)$/i;
function localPath(source, cwd, home) {
  if (typeof source !== "string") return null;
  source = source.trim().replace(/\\([ ()[\]])/g, "$1");
  if (
    !source ||
    source.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(source) ||
    source.startsWith("//")
  )
    return null;
  let value = source;
  try {
    if (value.startsWith("file:")) {
      const url = new URL(value);
      if (url.host || url.search || url.hash) return null;
      value = fileURLToPath(url);
    } else {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || /[?#]/.test(value)) return null;
      value = decodeURIComponent(value);
    }
  } catch {
    return null;
  }
  if (
    !imageExtension.test(value) ||
    /[\x00-\x1f\x7f\\]/.test(value) ||
    value.startsWith("//")
  )
    return null;
  const fullPath = value.startsWith("~/")
    ? path.resolve(home, value.slice(2))
    : path.resolve(cwd, value);
  return { path: source, fullPath };
}
function reportedImages(text, cwd, home) {
  if (typeof text !== "string") return [];
  text = text.slice(0, 128000);
  const matches = [];
  let remaining = text;
  const add = (source, index) => {
    const item = localPath(source, cwd, home);
    if (item) matches.push({ ...item, index });
    return Boolean(item);
  };
  const mask = (start, length) => {
    remaining =
      remaining.slice(0, start) + " ".repeat(length) + remaining.slice(start + length);
  };
  // Preserve spaces in explicit Markdown destinations and quoted/code paths.
  for (const match of text.matchAll(
    /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|((?:\\.|[^\s)])+))(?:\s+["'][^\n]*?["'])?\s*\)/g,
  )) {
    add(match[1] || match[2], match.index);
    mask(match.index, match[0].length);
  }
  for (const match of remaining.matchAll(/[`"']([^`"'\n]+)[`"']/g))
    if (add(match[1], match.index)) mask(match.index, match[0].length);
  for (const match of remaining.matchAll(/^(?:[ \t]*)([^\n]+)$/gm)) {
    const value = match[1].trim();
    if (
      /^(?:\/|\.\.?\/|~\/)/.test(value) &&
      imageExtension.test(value) &&
      (value.match(/\.(?:png|jpe?g|gif|webp|avif)(?=$|[\s,;])/gi) || []).length === 1 &&
      add(value, match.index)
    )
      mask(match.index, match[0].length);
  }
  for (const match of remaining.matchAll(/[^\s<>()[\]`"']+/g))
    add(match[0].replace(/[.,;:!?]+$/, ""), match.index);
  const unique = new Map();
  for (const item of matches.sort((a, b) => a.index - b.index))
    if (!unique.has(item.fullPath)) unique.set(item.fullPath, item);
  return [...unique.values()].slice(0, 8);
}
export function rasterType(bytes) {
  const ascii = (start, end) => bytes.toString("ascii", start, end);
  if (
    bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    ascii(12, 16) === "IHDR"
  ) {
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20);
    if (width && height && width * height <= 80_000_000) return "image/png";
    return null;
  }
  if (bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(ascii(0, 6))) {
    const width = bytes.readUInt16LE(6),
      height = bytes.readUInt16LE(8);
    if (width && height && width * height <= 80_000_000) return "image/gif";
    return null;
  }
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.length >= 20 &&
    ascii(0, 4) === "RIFF" &&
    ascii(8, 12) === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(ascii(12, 16))
  )
    return "image/webp";
  if (bytes.length >= 24 && ascii(4, 8) === "ftyp") {
    const boxSize = bytes.readUInt32BE(0);
    if (boxSize < 16 || boxSize > Math.min(bytes.length, 4096) || boxSize % 4 !== 0)
      return null;
    for (let offset = 8; offset + 4 <= boxSize; offset += 4)
      if (offset !== 12 && ["avif", "avis"].includes(ascii(offset, offset + 4)))
        return "image/avif";
  }
  return null;
}

export class ChatImages {
  constructor({ sessions, chat, home = os.homedir() }) {
    this.sessions = sessions;
    this.chat = chat;
    this.home = home;
    this.key = randomBytes(32);
  }
  descriptors(session, snapshot) {
    let remaining = 64;
    const messages = (snapshot.messages || []).map((message) => ({
      ...message,
      images: [],
    }));
    for (const message of [...messages].reverse()) {
      // Internal tool logs contain source code and temporary paths, not images
      // addressed to the user. They must not consume the conversation image budget.
      if (!["assistant", "user"].includes(message.role) || !remaining) continue;
      message.images = reportedImages(message.text, session.cwd, this.home)
        .slice(0, remaining)
        .map((item) => {
          const id = createHmac("sha256", this.key)
            .update(
              JSON.stringify([session.id, snapshot.providerSessionId, item.fullPath]),
            )
            .digest("hex");
          return {
            id,
            path: item.path,
            fullPath: item.fullPath,
            url: `/api/sessions/${encodeURIComponent(session.id)}/chat/images/${id}`,
          };
        });
      remaining -= message.images.length;
    }
    return messages;
  }
  async decorate(id, snapshot) {
    const session = await this.sessions.get(id);
    return {
      ...snapshot,
      messages: this.descriptors(session, snapshot).map((message) => ({
        ...message,
        images: message.images.map(({ fullPath: _fullPath, ...image }) => image),
      })),
    };
  }
  async read(id) {
    return this.decorate(id, await this.chat.read(id));
  }
  async file(id, imageId) {
    if (typeof imageId !== "string" || !/^[a-f0-9]{64}$/.test(imageId))
      throw problem(serverMessages.chat.imageNotFound, 404);
    const session = await this.sessions.get(id);
    const snapshot = await this.chat.read(id);
    const image = this.descriptors(session, snapshot)
      .flatMap((message) => message.images)
      .find((image) => image.id === imageId);
    if (!image) throw problem(serverMessages.chat.imageHistoryMismatch, 404);
    let handle;
    try {
      const source = await fs.lstat(image.fullPath);
      if (!source.isFile() || source.isSymbolicLink())
        throw problem(serverMessages.chat.imageNotRegularFile, 404);
      handle = await fs.open(image.fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.dev !== source.dev || stat.ino !== source.ino)
        throw problem(serverMessages.chat.imageChangedDuringRead, 404);
      if (stat.size > MAX_IMAGE_BYTES)
        throw problem(serverMessages.chat.imageTooLarge, 413);
      const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_IMAGE_BYTES + 1));
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > stat.size || size > MAX_IMAGE_BYTES)
        throw problem(serverMessages.chat.imageChangedOrTooLarge, 413);
      const body = buffer.subarray(0, size),
        type = rasterType(body);
      if (!type) throw problem(serverMessages.chat.unsupportedImageFormat, 415);
      return { body, type };
    } catch (error) {
      if (error.status) throw error;
      throw problem(serverMessages.chat.imageUnreadable, 404);
    } finally {
      await handle?.close();
    }
  }
}
