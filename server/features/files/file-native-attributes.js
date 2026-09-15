import { isUtf8 } from "node:buffer";
import { fileProblem } from "./file-errors.js";

export const metadataLimits = Object.freeze({
  names: 256,
  nameBytes: 65536,
  valueBytes: 8 * 1024 * 1024,
});
export function metadataLimit() {
  return fileProblem("FILE_METADATA_LIMIT", 413);
}

// Probe plus at most two retries. Never allocate from an unchecked native size.
export function boundedNativeBytes(read, limit) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const size = read(null, 0);
      if (!Number.isSafeInteger(size) || size < 0 || size > limit) throw metadataLimit();
      const bytes = Buffer.alloc(size);
      const received = read(bytes, bytes.length);
      if (!Number.isSafeInteger(received) || received < 0) throw metadataLimit();
      if (received > size)
        throw Object.assign(new Error("Metadata grew."), { code: "ERANGE" });
      return bytes.subarray(0, received);
    } catch (error) {
      if (!["ERANGE", "ENODATA", "ENOATTR"].includes(error.code)) throw error;
      if (attempt === 2) throw metadataLimit();
    }
  }
}

export function readAttributes(functions, fd) {
  const names = boundedNativeBytes(
    (buffer, size) => functions.list(fd, buffer, size),
    metadataLimits.nameBytes,
  );
  if (!isUtf8(names) || (names.length && names.at(-1) !== 0)) throw metadataLimit();
  const list = names.length ? names.subarray(0, -1).toString("utf8").split("\0") : [];
  if (list.length > metadataLimits.names || list.some((name) => !name))
    throw metadataLimit();
  const attributes = [];
  let remaining = metadataLimits.valueBytes;
  for (const name of list.sort()) {
    const value = boundedNativeBytes(
      (buffer, size) => functions.get(fd, name, buffer, size),
      remaining,
    );
    remaining -= value.length;
    attributes.push({ name, value });
  }
  return attributes;
}
