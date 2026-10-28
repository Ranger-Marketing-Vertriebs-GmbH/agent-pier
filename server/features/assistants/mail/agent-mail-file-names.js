import path from "node:path";
import { mailFileTypes } from "../../mail/mail-file-types.js";

// File names for attachments an agent saves (agent-mail-files.js). A sender picks
// the name, so it is reduced to one plain name that every file system takes and
// nobody misreads: its last path segment, NFC, without controls, format characters
// (bidi overrides, zero-width characters), default-ignorable code points or line
// separators, with the characters Windows forbids replaced, never hidden (no
// leading dot), never ending in a dot or space, never a Windows device name, and at
// most 180 bytes of UTF-8 with its extension kept.

export const nameBytes = 180;
const hidden = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}ᅟᅠㅤﾠ]/gu;
const forbidden = /[<>:"|?*]/g;
const edges = /^[\s.]+|[\s.]+$/gu;
const device = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const extensionBytes = 20;
const fallback = "attachment";

const bytes = (text) => Buffer.byteLength(text);
const clean = (text) =>
  String(text).toWellFormed().normalize("NFC").replace(hidden, "").normalize("NFC");

// The extension worth keeping when a name is shortened or numbered: a short one.
function split(name) {
  const extension = path.extname(name);
  if (extension.length < 2 || bytes(extension) > extensionBytes || /\s/u.test(extension))
    return [name, ""];
  return [name.slice(0, -extension.length), extension];
}

const typeExtension = (type) =>
  Object.keys(mailFileTypes).find((ext) => mailFileTypes[ext] === type) ?? "";

// `stem` + `suffix` + `extension` within the byte limit, one byte left for the
// device-name prefix: the stem is shortened by code points, at its end.
function fit(stem, suffix, extension) {
  const room = nameBytes - 1 - bytes(suffix) - bytes(extension);
  let points = Array.from(stem);
  let kept = stem;
  while (bytes(kept) > room || kept !== kept.normalize("NFC")) {
    points = points.slice(0, -1);
    kept = points.join("").replace(edges, "");
  }
  const name = `${kept || fallback}${suffix}${extension}`;
  return device.test(name) ? `_${name}` : name;
}

/**
 * A safe file name for an attachment named `name` (null or empty: `attachment`) of
 * MIME type `type`; only the fallback name gets the extension of a known type.
 */
export function safeFileName(name, type) {
  const segments = clean(name ?? "")
    .split(/[/\\]/)
    .map((part) => part.replace(forbidden, "_").replace(edges, ""))
    .filter(Boolean);
  const [stem, extension] = split(segments.at(-1) || fallback + typeExtension(type));
  return fit(stem, "", extension);
}

/** The `n`th name for a file named `name` (a safe name): `a.pdf`, `a (2).pdf`, … */
export function numberedName(name, n) {
  if (n <= 1) return name;
  const [stem, extension] = split(name);
  return fit(stem, ` (${n})`, extension);
}
