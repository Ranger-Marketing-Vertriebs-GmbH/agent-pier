// The OpenSSH client version, read once at service start. The session agent needs
// `session-bind@openssh.com`, which clients send since OpenSSH 8.9.
import { processOptions, runOpenSsh } from "./ssh-keys.js";

/** `{ major, minor }` from `ssh -V` output, or null when it is not OpenSSH. */
export function parseOpenSshVersion(text) {
  const match = /OpenSSH_(?:for_Windows_)?(\d{1,3})\.(\d{1,3})/.exec(String(text ?? ""));
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function supportsSessionBind(version) {
  if (!Number.isInteger(version?.major) || !Number.isInteger(version?.minor))
    return false;
  return version.major > 8 || (version.major === 8 && version.minor >= 9);
}

/** Runs `ssh -V` (which prints to stderr); null without ssh or for another client. */
export async function detectOpenSsh(run = runOpenSsh) {
  try {
    const { stdout, stderr } = await run("ssh", ["-V"], processOptions);
    return parseOpenSshVersion(`${stderr ?? ""}\n${stdout ?? ""}`);
  } catch {
    return null;
  }
}
