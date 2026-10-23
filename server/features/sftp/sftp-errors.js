// Stable SFTP problem codes. The code doubles as the message: callers translate
// it for the browser, and no host, path or credential ever enters it.
export const SFTP_STATUSES = Object.freeze({
  SFTP_AUTH_FAILED: 502,
  SFTP_HOST_KEY_MISMATCH: 502,
  SFTP_UNREACHABLE: 502,
  SFTP_TIMEOUT: 504,
  SFTP_NOT_FOUND: 404,
  SFTP_PERMISSION: 403,
  SFTP_PATH_REFUSED: 403,
  SFTP_LIMIT: 413,
  SFTP_TYPE_CONFLICT: 409,
  SFTP_PLAN_CHANGED: 409,
  SFTP_JOB_NOT_FOUND: 404,
  SFTP_BUSY: 429,
  SFTP_CANCELLED: 409,
  SFTP_FAILED: 502,
});

export function sftpProblem(code, status = SFTP_STATUSES[code]) {
  if (!Object.hasOwn(SFTP_STATUSES, code))
    throw new TypeError("Unknown SFTP problem code.");
  return Object.assign(new Error(code), { code, status });
}

export function isSftpProblem(error) {
  return Boolean(error) && Object.hasOwn(SFTP_STATUSES, error.code || "");
}
