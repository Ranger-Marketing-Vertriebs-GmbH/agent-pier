// What a Codex launch needs before it runs inside a nono sandbox (docs/sandbox.md).
import fs from "node:fs";
import path from "node:path";

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
export function sandboxLaunch(
  launch,
  { platform = process.platform, exists = fs.existsSync } = {},
) {
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
