import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import {
  inheritsFromLead,
  personalEligible,
  personalShell,
} from "./native-capabilities.js";
import { mcpEligible } from "./openclaw-config/mcp-servers.js";

// GitHub access for agents through AgentPier's token profiles (AGENTPIER-129): the
// official GitHub MCP server, bound per agent with its profile's token, and with shell
// on, gh and git using the same profile (github-credentials.js prepareAgent).
export const githubLevels = ["read", "write"];
export const githubRank = (level) => githubLevels.indexOf(level);
// Both levels see repositories, issues, pull requests and Actions (CI status). "read"
// runs the server read-only. "read and write" gets every tool of these toolsets, with
// no exclusions (AGENTPIER-134): it merges pull requests, pushes, deletes files, runs
// workflows and creates, forks and deletes repositories (checked against the pinned
// 2.0.2 release).
const toolsets = ["repos", "issues", "pull_requests", "actions"];
// Classic token scopes the tools need; a fine-grained token reports none and is not
// checked (its permissions cannot be read from the token).
export const requiredScopes = { read: ["repo"], write: ["repo"] };

/** The server's arguments for a level: stdio, its toolsets and, to read, read-only. */
export function githubServerArgs(level) {
  if (!githubLevels.includes(level)) throw Error(`Unknown GitHub level: ${level}`);
  return [
    "stdio",
    "--toolsets",
    toolsets.join(","),
    ...(level === "read" ? ["--read-only"] : []),
  ];
}

/**
 * The compiled server's name, also the agent's tool prefix (`<name>__<tool>`): one
 * server per profile and level, shared by every agent using that pair.
 */
export const githubServerName = (credentialId, level) =>
  `github_${level === "write" ? "rw" : "ro"}_${createHash("sha256")
    .update(String(credentialId))
    .digest("hex")
    .slice(0, 8)}`;

/** The server's environment: the token, and the host for GitHub Enterprise. */
export function githubServerEnv(host, token) {
  return {
    GITHUB_PERSONAL_ACCESS_TOKEN: token,
    ...(host && host !== "https://github.com" ? { GITHUB_HOST: host } : {}),
  };
}

/** A saved access `{ credentialId, level }` or null; refuses anything else. */
export function githubAccessInput(value, credentials = []) {
  if (value === null) return null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["credentialId", "level"].includes(key)) ||
    typeof value.credentialId !== "string" ||
    !githubLevels.includes(value.level)
  )
    throw assistantProblem("invalid");
  if (!credentials.some((entry) => entry.id === value.credentialId))
    throw assistantProblem("githubProfileUnavailable", 409);
  return { credentialId: value.credentialId, level: value.level };
}

/** The member's access: the lead's profile at the lower of both levels, or null. */
export function memberGithub(granted, held) {
  if (!githubLevels.includes(granted) || !githubLevels.includes(held?.level)) return null;
  return {
    credentialId: held.credentialId,
    level: githubLevels[Math.min(githubRank(granted), githubRank(held.level))],
  };
}

/** Scopes a profile's token lacks for a level; null while its scopes are unknown. */
export function missingScopes(scopes, level) {
  if (!Array.isArray(scopes) || !scopes.length) return null;
  return (requiredScopes[level] || []).filter((scope) => !scopes.includes(scope));
}

// The token check of a profile (AGENTPIER-128) when it records the token's scopes.
const knownScopes = (entry) =>
  Array.isArray(entry?.tokenCheck?.scopes) ? entry.tokenCheck.scopes : null;

/**
 * An agent's GitHub access as compiled and described: its own (an eligible agent's,
 * from its access record) or, for a temporary member, what its lead granted it within
 * the lead's access right now (the store resolves `inherited.github`). Reads never
 * throw: anything unreadable grants nothing.
 */
export class AgentGithub {
  constructor(workflows) {
    this.w = workflows;
  }
  get repositories() {
    return this.w.s.repositories;
  }
  credentials() {
    try {
      return this.repositories?.listCredentials() || [];
    } catch {
      return [];
    }
  }
  /** The profiles the Work tab offers: metadata and scope hints, never a token. */
  catalog() {
    return this.credentials().map((entry) => ({
      id: entry.id,
      name: entry.name,
      host: entry.host,
      agentDefault: entry.agentDefault === true,
      scopes: knownScopes(entry),
    }));
  }
  /** The managed server's state for the Work tab (github-mcp-tool.js). */
  server() {
    return this.w.s.githubMcp?.state() || { available: false, installed: false };
  }
  // A held access whose profile still exists, with that profile.
  resolve(access) {
    if (!access || !githubLevels.includes(access.level)) return null;
    const entry = this.credentials().find((c) => c.id === access.credentialId);
    return entry ? { credentialId: entry.id, level: access.level, entry } : null;
  }
  /** An eligible agent's own access; null for anyone else. */
  held(id) {
    try {
      if (!personalEligible(this.w.a.store.getAssistant(id))) return null;
      const access = this.w.access.get(id).github;
      return this.resolve(access) && { ...access };
    } catch {
      return null;
    }
  }
  /** The access that applies to `assistant`, with its profile, or null. */
  forAgent(assistant) {
    if (!assistant || assistant.archivedAt) return null;
    if (inheritsFromLead(assistant)) return this.resolve(assistant.inherited.github);
    if (!personalEligible(assistant)) return null;
    try {
      return this.resolve(this.w.access.get(assistant.id).github);
    } catch {
      return null;
    }
  }
  /** What the agent's instructions name: profile, host, level, tool prefix, shell. */
  describe(assistant) {
    const access = this.forAgent(assistant);
    if (!access) return null;
    return {
      profile: access.entry.name,
      host: access.entry.host,
      level: access.level,
      server: this.w.s.githubMcp?.executable()
        ? githubServerName(access.credentialId, access.level)
        : null,
      shell: personalShell(assistant) !== "off",
    };
  }
  /**
   * The servers, bindings and secrets the agents' access compiles to, in the shape
   * readMcpInputs reads from the server store: a stdio server per profile and level,
   * its token only in the server's env. None while the managed server is missing or a
   * token cannot be read; `taken` holds the store's own server names, which win.
   */
  mcpInputs(profiles = [], taken = new Set()) {
    const inputs = { servers: [], bindings: {}, secrets: {} };
    const command = this.w.s.githubMcp?.executable();
    if (!command) return inputs;
    const names = new Set([...taken].map((name) => String(name).toLowerCase()));
    for (const profile of profiles) {
      if (!mcpEligible(profile)) continue;
      const access = this.forAgent(profile);
      if (!access) continue;
      const name = githubServerName(access.credentialId, access.level);
      const id = `github:${access.credentialId}:${access.level}`;
      if (names.has(name.toLowerCase())) continue;
      if (!(id in inputs.secrets)) {
        const token = this.token(access.credentialId);
        if (!token) continue;
        inputs.servers.push({
          id,
          name,
          transport: "stdio",
          command,
          args: githubServerArgs(access.level),
          managed: "github",
        });
        inputs.secrets[id] = {
          headers: {},
          env: githubServerEnv(access.entry.host, token),
        };
      }
      inputs.bindings[profile.id] = [id];
    }
    return inputs;
  }
  token(credentialId) {
    try {
      const { token } = JSON.parse(
        fs.readFileSync(this.repositories.secretFile(credentialId), "utf8"),
      );
      return typeof token === "string" && token && !/[\x00-\x1f\x7f]/.test(token)
        ? token
        : null;
    } catch {
      return null;
    }
  }
  /**
   * Directories an agent's shell PATH starts with: its GitHub folder's marker (the
   * exec wrapper sources its environment) and the managed gh, when the agent has
   * shell and GitHub access. Prepares the folder on the way; never throws.
   */
  shellPath(assistant) {
    const github = this.w.s.github;
    const access = personalShell(assistant) !== "off" && this.forAgent(assistant);
    if (!github || !access) return [];
    try {
      const marker = github.prepareAgent(assistant.id, access.credentialId);
      if (!marker) return [];
      const gh = path.join(github.dataDir, "clis", "gh", "bin");
      return [marker, ...(fs.existsSync(gh) ? [gh] : [])];
    } catch {
      return [];
    }
  }
  /**
   * The same directories without preparing anything, for the approval analysis
   * (exec-approvals.js): only those that exist now. Never throws.
   */
  shellDirs(assistant) {
    const github = this.w.s.github;
    const access = personalShell(assistant) !== "off" && this.forAgent(assistant);
    if (!github?.agentMarker || !access) return [];
    try {
      return [
        github.agentMarker(assistant.id),
        path.join(github.dataDir, "clis", "gh", "bin"),
      ].filter((dir) => fs.existsSync(dir));
    } catch {
      return [];
    }
  }
  /** `{ [assistantId]: directories }` for a Gateway start; removes stale folders. */
  shellPaths(profiles = []) {
    const paths = {};
    for (const profile of profiles) {
      const dirs = this.shellPath(profile);
      if (dirs.length) paths[profile.id] = dirs;
    }
    this.sweep(new Set(Object.keys(paths)));
    return paths;
  }
  sweep(keep) {
    const github = this.w.s.github;
    if (!github?.agentFolders) return;
    for (const id of github.agentFolders())
      if (!keep.has(id))
        try {
          github.discardAgent(id);
        } catch {
          /* Retried at the next refresh. */
        }
  }
  /** A secret-free fingerprint of who uses which profile at which level. */
  signature(profiles) {
    return JSON.stringify(
      profiles.map((p) => {
        const a = this.forAgent(p);
        return a ? [p.id, a.credentialId, a.level, personalShell(p)] : [p.id];
      }),
    );
  }
  /**
   * Brings the running Gateway in line after an access, grant or profile change: MCP
   * servers (tokens included) are patched in, each agent with or without GitHub is
   * re-applied (instructions and shell PATH), stale shell folders go. The managed
   * server is installed on first use. Callers hold the admission lock.
   */
  async refresh(ids) {
    const profiles = this.w.a.store.listAssistants();
    const used = profiles.filter((p) => this.forAgent(p));
    if (used.length) this.w.s.githubMcp?.ensure();
    this.sweep(new Set(used.filter((p) => personalShell(p) !== "off").map((p) => p.id)));
    this.last = this.signature(profiles);
    const mcp = this.w.a.mcp;
    if (mcp) {
      mcp.pending = true;
      await mcp.applySaved();
    }
    // Agents that use GitHub now or did at the last refresh, and the ones named.
    const before = this.used || new Set();
    this.used = new Set(used.map((p) => p.id));
    if (!this.w.a.runtime?.client?.ready) return;
    const targets = new Set([...this.used, ...before, ...(ids || [])]);
    for (const profile of profiles)
      if (targets.has(profile.id))
        await this.w.a.config?.apply(profile.id).catch(() => {});
  }
  /** Whether who-uses-what changed since the last refresh (the team tick asks). */
  changed() {
    try {
      return this.signature(this.w.a.store.listAssistants()) !== this.last;
    } catch {
      return false;
    }
  }
}
