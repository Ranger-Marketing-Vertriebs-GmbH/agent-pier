// What a Codex launch needs before it runs inside a nono sandbox (docs/sandbox.md).
import fs from "node:fs";
import path from "node:path";
import { SHARED_FOLDERS, linkedFolderGrants } from "../linked-folders.js";
import { assetDirectories } from "./profile-files.js";

/** The CA bundle macOS ships as a file, the same roots as its system trust store. */
export const SYSTEM_CA_BUNDLE = "/etc/ssl/cert.pem";
// The variables Codex reads a CA bundle from (its own one first).
const CA_VARIABLES = ["SSL_CERT_FILE", "CODEX_CA_CERTIFICATE"];

/** `value` when it names a regular file by an absolute path, else null. */
function bundleFile(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return null;
  try {
    return fs.statSync(value).isFile() ? value : null;
  } catch {
    return null;
  }
}

/**
 * Codex verifies TLS certificates against the macOS trust store, which it reaches
 * through `com.apple.SecurityServer`. Every nono profile denies that lookup, so a
 * sandboxed Codex rejects every certificate ("invalid peer certificate:
 * UnknownIssuer") and never reaches its provider. With `SSL_CERT_FILE` it reads the
 * roots from a file instead.
 *
 * An operator's own `SSL_CERT_FILE` or `CODEX_CA_CERTIFICATE` (set for the server,
 * which passes both on to its sessions) stays as it is: it names the bundle they
 * want. That file may lie where the sandbox profile reads nothing, so it is granted
 * read-only, on every platform.
 */
function trustStoreLaunch(launch, { platform, exists }) {
  const env = launch.env || {};
  const named = CA_VARIABLES.filter((name) => env[name]);
  if (named.length) {
    const files = [...new Set(named.map((name) => bundleFile(env[name])))].filter(
      Boolean,
    );
    if (!files.length) return launch;
    return {
      ...launch,
      sandboxGrants: [
        ...(launch.sandboxGrants || []),
        ...files.map((file) => ({ access: "read", path: file })),
      ],
    };
  }
  if (platform !== "darwin" || !exists(SYSTEM_CA_BUNDLE)) return launch;
  return {
    ...launch,
    env: { ...env, SSL_CERT_FILE: SYSTEM_CA_BUNDLE },
    // The built-in profiles already read /etc; a tighter one may not.
    sandboxGrants: [
      ...(launch.sandboxGrants || []),
      { access: "read", path: SYSTEM_CA_BUNDLE },
    ],
  };
}

/**
 * A managed account's `skills`, `agents`, `commands`, `plugins` and
 * `.tmp/marketplaces` are links into the CLI's own profile (`~/.codex`), which the
 * account folder's grant does not cover. Codex reads `agents` when it starts and
 * ends on the denial ("Operation not permitted (os error 1)", the session shows "The
 * native Codex request backend stopped unexpectedly"); without the others it starts
 * and loads none of the shared skills and plugins.
 *
 * Granted are the link targets, read-only, never the profile itself: its login
 * (`auth.json`), history, sessions and databases stay out of reach. Nothing is
 * writable, so the skills Codex installs itself at start (`skills/.system`) are
 * those an unsandboxed session left there.
 */
export function sharedFolderGrants(env = {}) {
  if (!env.CODEX_HOME || !env.HOME) return [];
  return linkedFolderGrants({
    account: env.CODEX_HOME,
    native: path.join(env.HOME, ".codex"),
    names: [...SHARED_FOLDERS, ...assetDirectories],
  });
}

/** The launch with what Codex needs inside a nono sandbox. */
export function sandboxLaunch(
  launch,
  { platform = process.platform, exists = fs.existsSync } = {},
) {
  const prepared = trustStoreLaunch(launch, { platform, exists });
  const grants = sharedFolderGrants(launch.env);
  if (!grants.length) return prepared;
  return {
    ...prepared,
    sandboxGrants: [...(prepared.sandboxGrants || []), ...grants],
  };
}
