import { serverMessages } from "../../lib/i18n/de.js";
import path from "node:path";
import { problem } from "../../lib/storage.js";

export const hostTypes = ["ssh", "sftp"];
export const sftpAuths = ["password", "key"];

/** Optional allowed remote folder: absolute POSIX path, normalised, never `..`. */
export function remoteRootValue(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (
    typeof raw !== "string" ||
    raw.length > 1024 ||
    !raw.startsWith("/") ||
    /[\u0000-\u001f\u007f-\u009f]/.test(raw) ||
    raw.split("/").includes("..")
  )
    throw problem(serverMessages.ssh.invalidRemoteRoot);
  const normalised = path.posix.normalize(raw);
  return normalised.length > 1 ? normalised.replace(/\/+$/, "") : normalised;
}
