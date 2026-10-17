// The Work tab's GitHub access (server agent-github.js): `{ credentialId, level }` or
// null, with "read" or "write" as the level.
export const githubLevels = ["read", "write"];
// Classic token scopes the tools need (server requiredScopes).
const requiredScopes = { read: ["repo"], write: ["repo"] };

/** The profile a new access starts with: a host's "default for agents", github.com first. */
export function defaultGithubProfile(profiles = []) {
  const defaults = profiles.filter((p) => p.agentDefault);
  return (
    defaults.find((p) => p.host === "https://github.com") ||
    defaults[0] ||
    profiles[0] ||
    null
  );
}

/**
 * What the page shows for a draft value: its level, the chosen (or prefilled) profile
 * id and entry, and whether a stored profile no longer exists.
 */
export function githubChoice(value, profiles = []) {
  const list = profiles || [];
  const credentialId = value?.credentialId || defaultGithubProfile(list)?.id || null;
  const profile = list.find((p) => p.id === credentialId) || null;
  return {
    level: githubLevels.includes(value?.level) ? value.level : null,
    credentialId,
    profile,
    missing: !!value && !profile,
  };
}

/** Scopes the profile's token lacks for a level; null while its scopes are unknown. */
export function githubScopeGap(profile, level) {
  const scopes = profile?.scopes;
  if (!Array.isArray(scopes) || !scopes.length) return null;
  return (requiredScopes[level] || []).filter((scope) => !scopes.includes(scope));
}
