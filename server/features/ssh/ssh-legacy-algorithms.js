import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

// Old devices accept only the ssh-rsa (RSA/SHA-1) signature, which OpenSSH 8.8 and
// later disable. A host that opts in re-enables it for its own connections; these
// two options are the only ones a host can add, never free-form SSH options.
export const legacyOptions = [
  "PubkeyAcceptedAlgorithms=+ssh-rsa",
  "HostKeyAlgorithms=+ssh-rsa",
];

/** Whether a stored SSH host row opted in; rows without the field are off. */
export const usesLegacyAlgorithms = (row) =>
  row?.type !== "sftp" && row?.legacyAlgorithms === true;

/** The `-o` arguments a host's OpenSSH connection adds for legacy algorithms. */
export const legacyOptionArgs = (row) =>
  usesLegacyAlgorithms(row) ? legacyOptions.flatMap((option) => ["-o", option]) : [];

/** A validated request value: a boolean, or undefined when the request omits it. */
export function legacyAlgorithmsValue(raw) {
  if (raw === undefined || typeof raw === "boolean") return raw;
  throw problem(serverMessages.ssh.invalidAccessFields);
}
