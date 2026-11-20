import fs from "node:fs";

// Homebrew and npm package names as their registries allow them; anything else
// (spaces, quotes, `$`, `;`) never reaches a command the browser offers to copy.
const BREW_NAME = /^[a-z0-9][a-z0-9+._@-]*$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

/**
 * How an executable AgentPier does not manage was installed, read from its resolved
 * path: a Homebrew cask (`…/Caskroom/<name>/…`) or formula (`…/Cellar/<name>/…`),
 * a global npm package (`…/node_modules/<package>/…`), or `unknown`. Homebrew is
 * checked first, as a formula of a Node CLI keeps its packages inside the Cellar.
 * `command` is the update command for that method; only a name that passes the
 * registry's own rules makes one.
 */
export function cliInstallMethod(executable) {
  let real;
  try {
    real = typeof executable === "string" && executable && fs.realpathSync(executable);
  } catch {
    real = null;
  }
  if (!real) return { method: "unknown" };
  const parts = real.split("/");
  for (const [folder, flag] of [
    ["Caskroom", "--cask "],
    ["Cellar", ""],
  ]) {
    const name = parts[parts.lastIndexOf(folder) + 1];
    if (parts.includes(folder) && BREW_NAME.test(name || ""))
      return { method: "homebrew", command: `brew upgrade ${flag}${name}` };
  }
  const modules = parts.lastIndexOf("node_modules");
  if (modules >= 0) {
    const first = parts[modules + 1] || "";
    const name = first.startsWith("@") ? `${first}/${parts[modules + 2] || ""}` : first;
    if (NPM_NAME.test(name))
      return { method: "npm", command: `npm install -g ${name}@latest` };
  }
  return { method: "unknown" };
}
