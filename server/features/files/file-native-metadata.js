import { fstatSync, fchmodSync, fchownSync } from "node:fs";
import { getSystemErrorName } from "node:util";
import koffi from "koffi";
import { fileProblem } from "./file-errors.js";
import { readAttributes } from "./file-native-attributes.js";
import { assertMetadata, metadataFingerprint } from "./file-metadata.js";
import { linuxMetadataFunctions } from "./file-native-linux.js";
import { darwinMetadataFunctions } from "./file-native-darwin.js";

export function checkedNative(result) {
  if (result < 0) {
    const errno = koffi.errno();
    throw Object.assign(new Error("Native metadata operation failed."), {
      code: getSystemErrorName(-errno),
    });
  }
  return result;
}
export function metadataFunctions(library, platform) {
  const functions =
    platform === "darwin"
      ? darwinMetadataFunctions(library, checkedNative, koffi)
      : linuxMetadataFunctions(library, checkedNative);
  return metadataOperations(functions, platform);
}

export function metadataOperations(functions, platform) {
  function read(fd) {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink())
      throw fileProblem("FILE_UNSUPPORTED_TYPE", 415);
    const metadata = {
      completeness: functions.completeness,
      mode: Number(stat.mode & 0o7777n),
      uid: Number(stat.uid),
      gid: Number(stat.gid),
      mtimeNs: stat.mtimeNs,
      atimeNs: stat.atimeNs,
      acl: functions.acl(fd),
      xattrs: readAttributes(functions, fd),
    };
    const after = fstatSync(fd, { bigint: true });
    if (
      after.ctimeNs !== stat.ctimeNs ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino
    )
      throw fileProblem("FILE_PATH_CHANGED", 409);
    metadata.fingerprint = metadataFingerprint(metadata);
    return metadata;
  }
  function copy(source, target, { strictOwnership, preserveTimes }) {
    const sourceStat = fstatSync(source, { bigint: true }),
      targetStat = fstatSync(target, { bigint: true });
    if (
      (!sourceStat.isFile() &&
        !sourceStat.isDirectory() &&
        !sourceStat.isSymbolicLink()) ||
      (sourceStat.mode & 0o170000n) !== (targetStat.mode & 0o170000n)
    )
      throw fileProblem("FILE_UNSUPPORTED_TYPE", 415);
    if (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino)
      return { warnings: [] };
    const expected = read(source),
      previous = read(target);
    const complete =
      expected.completeness?.complete === true &&
      previous.completeness?.complete === true;
    if (strictOwnership && !complete) throw fileProblem("FILE_METADATA_UNSUPPORTED", 409);
    const warnings = complete ? [] : [{ code: "FILE_METADATA_UNSUPPORTED", args: {} }];
    const omitted = new Set();
    let omittedAcl = false;
    const warn = (error, name) => {
      if (
        strictOwnership ||
        !["ENOTSUP", "EOPNOTSUPP", "EPERM", "EACCES"].includes(error.code)
      )
        throw error;
      if (name) omitted.add(name);
      if (!warnings.length)
        warnings.push({ code: "FILE_METADATA_UNSUPPORTED", args: {} });
    };
    if (previous.uid !== expected.uid || previous.gid !== expected.gid) {
      try {
        if (platform === "linux") functions.owner(target, expected.uid, expected.gid);
        else fchownSync(target, expected.uid, expected.gid);
      } catch (error) {
        warn(error);
      }
    }
    if (platform === "linux") {
      if (!fstatSync(target).isSymbolicLink()) functions.mode(target, expected.mode);
    } else fchmodSync(target, expected.mode);
    for (const { name } of previous.xattrs) {
      if (!expected.xattrs.some((attribute) => attribute.name === name)) {
        try {
          functions.remove(target, name);
        } catch (error) {
          warn(error, name);
        }
      }
    }
    // Linux POSIX ACLs are system.posix_acl_* xattrs, applied after chown/chmod.
    for (const { name, value } of expected.xattrs) {
      try {
        functions.set(target, name, value);
      } catch (error) {
        warn(error, name);
      }
    }
    try {
      functions.copyAcl(source, target, expected.acl);
    } catch (error) {
      warn(error);
      omittedAcl = true;
    }
    if (preserveTimes) {
      const times = Buffer.alloc(32);
      for (const [index, nanoseconds] of [expected.atimeNs, expected.mtimeNs].entries()) {
        let seconds = nanoseconds / 1000000000n,
          remainder = nanoseconds % 1000000000n;
        if (remainder < 0n) {
          seconds--;
          remainder += 1000000000n;
        }
        times.writeBigInt64LE(seconds, index * 16);
        times.writeBigInt64LE(remainder, index * 16 + 8);
      }
      functions.times(target, times);
    }
    const actual = read(target);
    const compared = (value) => ({
      ...value,
      acl: omittedAcl ? null : value.acl,
      xattrs: value.xattrs.filter((attribute) => !omitted.has(attribute.name)),
    });
    assertMetadata(compared(expected), compared(actual), { strictOwnership });
    if (
      preserveTimes &&
      (actual.mtimeNs !== expected.mtimeNs || actual.atimeNs !== expected.atimeNs)
    )
      throw fileProblem("FILE_METADATA_MISMATCH", 409);
    if (read(source).fingerprint !== expected.fingerprint)
      throw fileProblem("FILE_PATH_CHANGED", 409);
    return { warnings };
  }
  return { read, copy, rename: functions.rename };
}
