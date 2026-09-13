export function fileProblem(code, status, args = {}) {
  return Object.assign(new Error("File operation failed."), { code, status, args });
}

// Keep OS diagnostics out of browser-visible errors; callers expose code and args.
export function fileSystemProblem(error) {
  if (error.code?.startsWith("FILE_")) return error;
  const mapped = {
    ENOENT: ["FILE_NOT_FOUND", 404],
    ENOTDIR: ["FILE_NOT_DIRECTORY", 400],
    ELOOP: ["FILE_LINK_LOOP", 409],
    EACCES: ["FILE_ACCESS_DENIED", 403],
    EPERM: ["FILE_ACCESS_DENIED", 403],
    ENAMETOOLONG: ["FILE_INVALID_PATH", 400],
  }[error.code] || ["FILE_IO_ERROR", 500];
  return fileProblem(...mapped);
}
