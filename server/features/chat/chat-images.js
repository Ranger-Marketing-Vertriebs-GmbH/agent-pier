import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { problem } from "../../lib/storage.js";
import { UploadedImageInput } from "./uploaded-image-input.js";
import { truncateToolRow } from "./tool-text.js";
import { ToolTextStore } from "./tool-text-store.js";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_HISTORY_PAGES = 20;
const MISS_TTL = 60_000;
const MAX_MISSES = 1024;
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
    /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|((?:\\.|[^\\\s)])+))(?:\s+["'][^\n]*?["'])?\s*\)/g,
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
  constructor({
    sessions,
    chat,
    attachments,
    home = os.homedir(),
    toolTexts = new ToolTextStore(),
    toolImages = new ToolTextStore({
      maxBytes: 128 * 1048576,
      maxEntryBytes: 32 * 1048576,
    }),
  }) {
    this.sessions = sessions;
    this.chat = chat;
    this.attachments = attachments;
    this.home = home;
    this.key = randomBytes(32);
    this.historical = new Map();
    this.uploadedInput = new UploadedImageInput();
    this.toolTexts = toolTexts;
    this.toolImages = toolImages;
    this.misses = new Map();
  }
  toolImageRefs(id, providerSessionId, row) {
    const images = [],
      entries = [];
    (row.toolImages || []).forEach(({ mime, data }, index) => {
      const number = index + 1;
      const imageId = sha256(
        JSON.stringify([id, providerSessionId ?? null, row.id, number, sha256(data)]),
      );
      images.push({
        id: imageId,
        path: row.toolImagePath
          ? `${path.basename(row.toolImagePath)} · ${number}`
          : `image ${number}`,
      });
      entries.push({ imageId, mime, data });
    });
    return { images, entries };
  }
  rememberToolImage(id, providerSessionId, { imageId, mime, data }) {
    this.toolImages.remember(
      id,
      imageId,
      JSON.stringify([providerSessionId ?? null, mime]),
      data,
    );
  }
  toolPayload(id, providerSessionId, source, row) {
    if (source?.role !== "tool") return row;
    let next = row;
    if (source.toolImages?.length) {
      const { images, entries } = this.toolImageRefs(id, providerSessionId, source);
      for (const entry of entries) this.rememberToolImage(id, providerSessionId, entry);
      const { toolImages: _images, toolImagePath: _path, ...rest } = next;
      next = { ...rest, images };
    } else if ("toolImages" in next || "toolImagePath" in next) {
      const { toolImages: _images, toolImagePath: _path, ...rest } = next;
      next = rest;
    }
    const { row: truncated, full } = truncateToolRow(next);
    if (full !== null)
      this.toolTexts.remember(id, row.id, providerSessionId ?? null, full);
    return truncated;
  }
  // Tool image ids hash the session, provider session, row and bytes, so the
  // served content never changes for an id and clients may cache it for good.
  sniffedToolImage(base64) {
    const body = Buffer.from(base64, "base64");
    const type = rasterType(body);
    return type ? { type, body, immutable: true } : null;
  }
  // Rows evicted from the stores may only exist on older history pages. Walk a
  // bounded number of pages back from the live window without registering
  // client cursors; an expired or mismatched cursor simply ends the walk.
  async *olderMessages(id, snapshot) {
    const current = snapshot.providerSessionId ?? null;
    const cursor = snapshot.history?.cursor;
    if (typeof cursor !== "string" || !cursor || !this.chat.olderPages) return;
    const pages = this.chat.olderPages(id, cursor, MAX_HISTORY_PAGES);
    try {
      for (;;) {
        let next;
        try {
          next = await pages.next();
        } catch {
          return;
        }
        if (next.done || (next.value?.providerSessionId ?? null) !== current) return;
        yield next.value.messages || [];
      }
    } finally {
      await pages.return?.().catch(() => {});
    }
  }
  // Unknown or stale ids are remembered briefly so repeated requests do not
  // repeat the history walk.
  missKey(id, snapshot, kind, value) {
    return JSON.stringify([id, snapshot.providerSessionId ?? null, kind, value]);
  }
  knownMiss(key) {
    const expires = this.misses.get(key);
    if (expires > Date.now()) return true;
    this.misses.delete(key);
    return false;
  }
  rememberMiss(key) {
    this.misses.delete(key);
    this.misses.set(key, Date.now() + MISS_TTL);
    while (this.misses.size > MAX_MISSES)
      this.misses.delete(this.misses.keys().next().value);
  }
  forgetSession(id) {
    this.toolTexts.forgetSession(id);
    this.toolImages.forgetSession(id);
    for (const key of this.misses.keys())
      if (JSON.parse(key)[0] === id) this.misses.delete(key);
  }
  async walkFor(id, snapshot, kind, value, find) {
    const key = this.missKey(id, snapshot, kind, value);
    if (this.knownMiss(key)) return null;
    for await (const messages of this.olderMessages(id, snapshot)) {
      const found = find(messages);
      if (found === null) break;
      if (found !== undefined) return found;
    }
    this.rememberMiss(key);
    return null;
  }
  storedToolImage(id, snapshot, imageId) {
    const current = snapshot.providerSessionId ?? null;
    const stored = this.toolImages.lookup(id, imageId);
    if (!stored) return null;
    const [provider] = JSON.parse(stored.providerSessionId);
    return provider === current ? this.sniffedToolImage(stored.text) : null;
  }
  toolImageEntry(id, current, messages, imageId) {
    for (const row of messages) {
      if (row?.role !== "tool" || !row.toolImages?.length) continue;
      const found = this.toolImageRefs(id, current, row).entries.find(
        (entry) => entry.imageId === imageId,
      );
      if (found) return found;
    }
    return null;
  }
  async derivedToolImage(id, snapshot, imageId) {
    const current = snapshot.providerSessionId ?? null;
    const found =
      this.toolImageEntry(id, current, snapshot.messages || [], imageId) ||
      (await this.walkFor(
        id,
        snapshot,
        "image",
        imageId,
        (messages) => this.toolImageEntry(id, current, messages, imageId) || undefined,
      ));
    if (!found) return null;
    const image = this.sniffedToolImage(found.data);
    if (!image) return null;
    this.rememberToolImage(id, current, found);
    return image;
  }
  async fullText(id, messageId) {
    const snapshot = await this.chat.read(id);
    const current = snapshot.providerSessionId ?? null;
    const stored = this.toolTexts.lookup(id, messageId);
    if (stored && stored.providerSessionId === current) return stored.text;
    const isText = (row) => row?.role === "tool" && typeof row.text === "string";
    const row = snapshot.messages?.find((message) => message.id === messageId);
    if (isText(row)) return row.text;
    const older = await this.walkFor(id, snapshot, "text", messageId, (messages) => {
      const found = messages.find((message) => message?.id === messageId);
      return found ? (isText(found) ? found.text : null) : undefined;
    });
    if (older === null) throw problem(serverMessages.chat.toolTextUnavailable, 404);
    this.toolTexts.remember(id, messageId, current, older);
    return older;
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
    const messages = await this.uploadedInput.decorate(
      session,
      this.descriptors(session, snapshot).map((message) => ({
        ...message,
        images: message.images.map(({ fullPath: _fullPath, ...image }) => image),
      })),
      session.attachments?.directory || this.attachments?.folder(id),
    );
    return {
      ...snapshot,
      messages: messages.map((message, index) =>
        this.toolPayload(
          id,
          snapshot.providerSessionId,
          snapshot.messages?.[index],
          message,
        ),
      ),
    };
  }
  async read(id) {
    return this.decorate(id, await this.chat.read(id));
  }
  async decoratePage(id, snapshot) {
    const session = await this.sessions.get(id);
    const scope = JSON.stringify([
      session.id,
      session.accountId,
      session.tool,
      session.cwd,
      snapshot.providerSessionId,
      snapshot.history?.generation,
    ]);
    for (const message of this.descriptors(session, snapshot))
      for (const image of message.images) {
        this.historical.delete(image.id);
        this.historical.set(image.id, { image, scope, expires: Date.now() + 3600000 });
      }
    while (this.historical.size > 1024)
      this.historical.delete(this.historical.keys().next().value);
    return this.decorate(id, snapshot);
  }
  async file(id, imageId) {
    if (typeof imageId !== "string" || !/^[a-f0-9]{64}$/.test(imageId))
      throw problem(serverMessages.chat.imageNotFound, 404);
    const session = await this.sessions.get(id);
    const snapshot = await this.chat.read(id);
    const cached = this.storedToolImage(id, snapshot, imageId);
    if (cached) return cached;
    let image = this.descriptors(session, snapshot)
      .flatMap((message) => message.images)
      .find((image) => image.id === imageId);
    const historical = this.historical.get(imageId);
    const scope = JSON.stringify([
      session.id,
      session.accountId,
      session.tool,
      session.cwd,
      snapshot.providerSessionId,
      snapshot.history?.generation,
    ]);
    if (!image && historical?.scope === scope && historical.expires > Date.now())
      image = historical.image;
    if (!image) {
      const derived = await this.derivedToolImage(id, snapshot, imageId);
      if (derived) return derived;
      throw problem(serverMessages.chat.imageHistoryMismatch, 404);
    }
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
