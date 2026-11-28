import { withUtf8Locale } from "./session-locale.js";

/**
 * The environment a program AgentPier starts gets from the service's own: the
 * variables below and nothing else, with a UTF-8 locale and a colour terminal. It
 * lives in a module without npm dependencies, because the installer scripts load it
 * (through the Android device paths) before `npm ci` has run.
 */
export function cleanEnvironment(source = process.env) {
  const env = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "SSH_AUTH_SOCK",
    "DISPLAY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    // Codex's own variable for a CA bundle; it reads SSL_CERT_FILE otherwise.
    "CODEX_CA_CERTIFICATE",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
  ])
    if (typeof source[key] === "string") env[key] = source[key];
  return { ...withUtf8Locale(env), TERM: "xterm-256color", COLORTERM: "truecolor" };
}
