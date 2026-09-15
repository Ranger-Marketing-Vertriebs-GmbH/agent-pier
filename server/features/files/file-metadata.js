import { createHash } from "node:crypto";
import { FileNative } from "./file-native.js";
import { fileProblem } from "./file-errors.js";

function operand(value) {
  if (
    value?.native instanceof FileNative &&
    Number.isSafeInteger(value.handle) &&
    value.handle > 0
  )
    return { native: value.native, argument: value.handle, borrowed: false };
  if (
    value &&
    typeof value.stat === "function" &&
    typeof value.close === "function" &&
    Number.isInteger(value.fd) &&
    value.fd >= 0
  )
    return { argument: value.fd, borrowed: true };
  throw fileProblem("FILE_INVALID_PATH", 400);
}

// Borrowed FileHandles stay caller-owned: keep them open until this Promise settles.
// Worker references are {native: FileNative, handle: opaqueId}; never pass raw IDs.
export async function readMetadata(handle) {
  const source = operand(handle);
  const native = source.native || new FileNative();
  try {
    return await native.run(source.borrowed ? "readBorrowedMetadata" : "readMetadata", {
      handle: source.argument,
    });
  } finally {
    if (!source.native) await native.close();
  }
}

export async function copyMetadata(
  sourceHandle,
  targetHandle,
  { strictOwnership = true, preserveTimes = true } = {},
) {
  const source = operand(sourceHandle),
    target = operand(targetHandle);
  if (source.native && target.native && source.native !== target.native)
    throw fileProblem("FILE_INVALID_PATH", 400);
  const native = source.native || target.native || new FileNative();
  try {
    return await native.run("copyMetadata", {
      source: source.argument,
      target: target.argument,
      sourceBorrowed: source.borrowed,
      targetBorrowed: target.borrowed,
      strictOwnership,
      preserveTimes,
    });
  } finally {
    if (!source.native && !target.native) await native.close();
  }
}

function comparable(metadata, strictOwnership) {
  return {
    mode: metadata.mode,
    ...(strictOwnership ? { uid: metadata.uid, gid: metadata.gid } : {}),
    acl: metadata.acl == null ? null : Buffer.from(metadata.acl).toString("base64"),
    xattrs: metadata.xattrs
      .map(({ name, value }) => [name, Buffer.from(value).toString("base64")])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}
export function metadataFingerprint(metadata) {
  return createHash("sha256")
    .update(JSON.stringify(comparable(metadata, true)))
    .digest("hex");
}
export function assertMetadata(expected, actual, { strictOwnership = true } = {}) {
  if (
    strictOwnership &&
    (expected.completeness?.complete !== true || actual.completeness?.complete !== true)
  )
    throw fileProblem("FILE_METADATA_UNSUPPORTED", 409);
  if (
    JSON.stringify(comparable(expected, strictOwnership)) !==
    JSON.stringify(comparable(actual, strictOwnership))
  )
    throw fileProblem("FILE_METADATA_MISMATCH", 409);
}
