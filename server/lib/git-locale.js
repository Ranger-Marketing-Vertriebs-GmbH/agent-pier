/**
 * The environment for a git process whose messages AgentPier matches: git (and
 * Homebrew git on a localized macOS even without LANG) translates its errors, so
 * the C locale keeps them English. Git output shown to the owner as evidence keeps
 * the owner's language and does not use this.
 */
export function gitMessageEnvironment(env) {
  return { ...env, LC_ALL: "C", LANGUAGE: "C" };
}
