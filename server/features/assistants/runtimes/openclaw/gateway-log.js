import fs from "node:fs";

export const consoleLogLimit = { maxBytes: 10 * 1024 * 1024, files: 3 };

function size(file) {
  try {
    return fs.lstatSync(file).size;
  } catch {
    return 0;
  }
}

// Copy-then-truncate: the Gateway keeps its O_APPEND descriptor, so writes after the
// truncation continue at the start of the now-empty active file.
export function rotateConsoleLog(file, { maxBytes, files } = consoleLogLimit) {
  if (size(file) < maxBytes) return false;
  for (let index = files - 1; index > 1; index--)
    if (fs.existsSync(`${file}.${index - 1}`))
      fs.renameSync(`${file}.${index - 1}`, `${file}.${index}`);
  if (files > 1) {
    fs.copyFileSync(file, `${file}.1`);
    fs.chmodSync(`${file}.1`, 0o600);
  }
  fs.truncateSync(file, 0);
  return true;
}

export function openConsoleLog(file, limit = consoleLogLimit) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink()))
    throw Object.assign(Error("Unsafe assistant log."), {
      code: "ASSISTANT_STORAGE_UNSAFE",
    });
  rotateConsoleLog(file, limit);
  const descriptor = fs.openSync(
    file,
    fs.constants.O_WRONLY |
      fs.constants.O_APPEND |
      fs.constants.O_CREAT |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  // A pre-existing file keeps its mode on open; tighten it explicitly.
  fs.fchmodSync(descriptor, 0o600);
  return descriptor;
}
