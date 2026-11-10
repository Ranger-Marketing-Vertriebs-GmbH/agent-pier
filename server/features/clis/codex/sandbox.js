// What a Codex launch needs before it runs inside a nono sandbox (docs/sandbox.md).
import fs from "node:fs";

/** The CA bundle macOS ships as a file, the same roots as its system trust store. */
export const SYSTEM_CA_BUNDLE = "/etc/ssl/cert.pem";

/**
 * Codex verifies TLS certificates against the macOS trust store, which it reaches
 * through `com.apple.SecurityServer`. Every nono profile denies that lookup, so a
 * sandboxed Codex rejects every certificate ("invalid peer certificate:
 * UnknownIssuer") and never reaches its provider. With `SSL_CERT_FILE` it reads the
 * roots from a file instead. An operator's own `SSL_CERT_FILE` or
 * `CODEX_CA_CERTIFICATE` stays as it is: it names the bundle they want.
 */
export function sandboxLaunch(
  launch,
  { platform = process.platform, exists = fs.existsSync } = {},
) {
  const env = launch.env || {};
  if (platform !== "darwin" || env.SSL_CERT_FILE || env.CODEX_CA_CERTIFICATE)
    return launch;
  if (!exists(SYSTEM_CA_BUNDLE)) return launch;
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
