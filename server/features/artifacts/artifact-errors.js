import { serverMessages } from "../../lib/i18n/de.js";
export function artifactError(code, status = 400) {
  return Object.assign(new Error(serverMessages.artifacts[code] || code), {
    code,
    status,
  });
}
export function artifactFailure(error) {
  if (error.code?.startsWith("ARTIFACT_")) return error;
  if (error.status === 403) return artifactError("ARTIFACT_ACCESS_DENIED", 403);
  if (["ENOSPC", "EDQUOT"].includes(error.code))
    return artifactError("ARTIFACT_STORAGE_FULL", 413);
  if (error.code?.startsWith("FILE_"))
    return artifactError("ARTIFACT_INVALID_SOURCE", 400);
  return artifactError("ARTIFACT_IO_ERROR", 500);
}
export const artifactLimits = {
  publicationBytes: 50 * 1024 * 1024,
  files: 500,
  totalBytes: 1024 * 1024 * 1024,
};
export const artifactId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
