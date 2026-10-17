/**
 * launchd and systemd start the service without a locale, so sessions would inherit
 * none: bash 3.2 readline then reads non-ASCII input as Meta keys. Sessions get a
 * UTF-8 LANG unless the owner set LANG, LC_ALL or LC_CTYPE. macOS always ships
 * en_US.UTF-8; C.UTF-8 is built into glibc 2.35+, Debian/Ubuntu and musl.
 */
const localeVariables = ["LANG", "LC_ALL", "LC_CTYPE"];

export const defaultUtf8Locale = (platform = process.platform) =>
  platform === "linux" ? "C.UTF-8" : "en_US.UTF-8";

export function withUtf8Locale(env, platform = process.platform) {
  if (localeVariables.some((key) => typeof env[key] === "string" && env[key] !== ""))
    return env;
  return { ...env, LANG: defaultUtf8Locale(platform) };
}
