import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  personalEligible,
  personalShell,
  personalSkills,
} from "./native-capabilities.js";
import {
  shadowingSkillNames,
  skillShadowRoots,
} from "./openclaw-config/skill-shadows.js";
import { assistantProblem, skillNamePattern } from "./assistant-validation.js";

// Bundled OpenClaw skills per agent (docs/assistant-gateway.md#skills). The owner
// switches skills on per agent; AgentPier compiles the list into
// agents.entries.<id>.skills, which OpenClaw reads as the agent's final allow list
// (agents.defaults.skills stays [], so an agent without a list has none). Only
// skills the runtime bundles are assignable: never ClawHub or workspace skills.

const bundledSource = "openclaw-bundled";
const requirementKeys = ["bins", "anyBins", "env", "config", "os"];

/**
 * Bundled skills that are shown with a warning before they are switched on, by
 * reason: they install foreign code, steer the Gateway, change the host, duplicate
 * an AgentPier feature, or reach secrets.
 */
export const skillRisks = {
  clawhub: "installsCode",
  "skill-creator": "installsCode",
  "control-ui": "steersGateway",
  "node-connect": "steersGateway",
  healthcheck: "changesHost",
  "coding-agent": "duplicates",
  visualize: "duplicates",
  mcporter: "duplicates",
  "1password": "secrets",
};

/**
 * The names the installed runtime bundles (`<package>/skills/<name>/SKILL.md`); a
 * workspace skill of the same name would win over it in OpenClaw.
 */
export function bundledSkillNames(entryPath) {
  if (!entryPath) return new Set();
  const root = path.join(path.dirname(entryPath), "skills");
  try {
    return new Set(
      fs
        .readdirSync(root, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            skillNamePattern.test(entry.name) &&
            fs.existsSync(path.join(root, entry.name, "SKILL.md")),
        )
        .map((entry) => entry.name),
    );
  } catch {
    return new Set();
  }
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replaces the given absolute host directories with "…" in text, only where a whole
 * path segment matches (`/Users/d` never cuts into `/Users/dave`).
 */
export function withoutHostPaths(text, roots = []) {
  let result = String(text ?? "");
  for (const root of roots.filter((r) => path.isAbsolute(r || "") && r.length > 1)) {
    const clean = root.replace(/\/+$/, "");
    result = result.replace(new RegExp(`${escapeRegExp(clean)}(?![\\w.-])`, "g"), "…");
  }
  return result;
}

const strings = (value, roots, max = 32) =>
  Array.isArray(value)
    ? value
        .filter((item) => typeof item === "string")
        .slice(0, max)
        .map((item) => withoutHostPaths(item, roots).slice(0, 200))
    : [];
const requirementsOf = (value, roots) =>
  Object.fromEntries(requirementKeys.map((key) => [key, strings(value?.[key], roots)]));
const webAddress = (value) =>
  typeof value === "string" && /^https?:\/\/[^\s]+$/i.test(value) && value.length <= 300
    ? value
    : undefined;

/**
 * One bundled skill as the browser sees it: no file or base paths, no install
 * options, no config checks; host directories are cut out of every text.
 */
export function sanitizeSkill(entry, roots = []) {
  const missing = requirementsOf(entry.missing, roots);
  const requirements = requirementsOf(entry.requirements, roots);
  const state =
    entry.platformIncompatible || missing.os.length
      ? "unsupported"
      : entry.disabled
        ? "disabled"
        : requirementKeys.some((key) => missing[key].length) || entry.eligible === false
          ? "missing"
          : "ready";
  return {
    name: entry.name,
    description: withoutHostPaths(entry.description, roots).slice(0, 1000),
    ...(typeof entry.emoji === "string" && entry.emoji.length <= 16
      ? { emoji: entry.emoji }
      : {}),
    ...(webAddress(entry.homepage) ? { homepage: entry.homepage } : {}),
    state,
    missing,
    // A skill whose recipe runs programs is of no use to an agent without shell.
    usesShell: requirements.bins.length > 0 || requirements.anyBins.length > 0,
  };
}

/**
 * The agent's skill page from OpenClaw's `skills.status` report for that agent and
 * the runtime's bundled names. A bundled name that the report resolves to another
 * source is `shadowed`: a workspace (or other) skill of that name would run instead,
 * so it is never shown as the bundled one; so is one a skill in the agent's folders
 * would replace (`shadowed`, skill-shadows.js). The compiler drops both from the
 * agent's list while the owner's choice stays stored. A `fallback` report was read
 * for another agent (this one does not exist in the Gateway yet): its other
 * sources and agent filter say nothing about this agent.
 */
export function skillCatalog({
  report,
  bundled = new Set(),
  assistant,
  roots = [],
  shadowed = new Set(),
  fallback = false,
}) {
  const entries = new Map();
  for (const entry of Array.isArray(report?.skills) ? report.skills : [])
    if (
      typeof entry?.name === "string" &&
      skillNamePattern.test(entry.name) &&
      (!fallback || entry.source === bundledSource)
    )
      entries.set(entry.name, entry);
  const assigned = personalSkills(assistant);
  const names = new Set([
    ...bundled,
    ...assigned,
    ...[...entries.values()]
      .filter((entry) => entry.source === bundledSource)
      .map((entry) => entry.name),
  ]);
  const skills = [...names].sort().map((name) => {
    const entry = entries.get(name);
    const on = assigned.includes(name);
    const hidden = {
      name,
      description: "",
      state: "shadowed",
      missing: requirementsOf({}, roots),
      usesShell: false,
    };
    const base = entry
      ? entry.source !== bundledSource
        ? hidden
        : shadowed.has(name)
          ? { ...sanitizeSkill(entry, roots), state: "shadowed" }
          : sanitizeSkill(entry, roots)
      : {
          name,
          description: "",
          state: "unavailable",
          missing: requirementsOf({}, roots),
          usesShell: false,
        };
    return {
      ...base,
      assigned: on,
      // OpenClaw confirms it offers the skill to this agent's next turn.
      active:
        on &&
        !fallback &&
        base.state === "ready" &&
        entry?.blockedByAgentFilter === false,
      ...(Object.hasOwn(skillRisks, name) ? { risk: skillRisks[name] } : {}),
    };
  });
  return { skills, assigned, shell: personalShell(assistant) };
}

// OpenClaw answers INVALID_REQUEST `unknown agent id "<id>"` (gateway-client.js keeps
// the reason as remoteMessage).
const unknownAgent = (error) =>
  error?.code === "INVALID_REQUEST" && /unknown agent/i.test(error?.remoteMessage || "");

/** Reads an agent's skills from the running Gateway and checks assignments. */
export class AgentSkills {
  constructor({ store, runtime, roots = [os.homedir(), os.userInfo().homedir] }) {
    Object.assign(this, { store, runtime, roots });
  }
  async report(assistant) {
    const client = this.runtime.client;
    if (!client?.ready) throw assistantProblem("unavailable", 503);
    try {
      return await client.call("skills.status", { agentId: assistant.runtimeAgentId });
    } catch (error) {
      // An agent the Gateway has not created yet (no apply so far) has no workspace
      // of its own; the bundled skills and their requirements are the same.
      if (!unknownAgent(error)) throw error;
      return { ...(await client.call("skills.status", {})), fallback: true };
    }
  }
  /** The catalog for an eligible agent; 400 for temporary members and archived ones. */
  async list(id) {
    const assistant = this.store.getAssistant(id);
    if (!personalEligible(assistant)) throw assistantProblem("invalid");
    const report = await this.report(assistant);
    const entryPath = this.runtime.runtime?.entryPath;
    const roots = [
      ...this.roots,
      this.runtime.paths?.root,
      entryPath && path.dirname(path.dirname(path.dirname(entryPath))),
      report?.workspaceDir,
      report?.managedSkillsDir,
    ].filter((root) => typeof root === "string" && path.isAbsolute(root));
    // Longest first, so a nested directory is cut before its parent.
    roots.sort((a, b) => b.length - a.length);
    const root = this.runtime.paths?.root;
    return skillCatalog({
      report,
      bundled: bundledSkillNames(entryPath),
      assistant,
      roots,
      shadowed: root
        ? shadowingSkillNames(skillShadowRoots(root, assistant.id))
        : new Set(),
      fallback: report?.fallback === true,
    });
  }
  /** Runs `apply` once, shortly after the last of a burst of skills.changed events. */
  changed(apply, delayMs = 500) {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () =>
        Promise.resolve()
          .then(apply)
          .catch(() => {}),
      delayMs,
    );
    this.timer.unref?.();
  }
  /** Applies every agent with skills again, past the unchanged-config shortcut. */
  async reapply(config) {
    for (const assistant of this.store.listAssistants())
      if (personalSkills(assistant).length) {
        config.applied?.delete(assistant.id);
        await config.apply(assistant.id).catch(() => {});
      }
  }
  /**
   * Refuses a list with a skill that is not bundled, or that another skill of the
   * same name shadows, before anything is stored. Names already assigned may stay,
   * so a runtime that dropped one never blocks other changes.
   */
  async check(current, names) {
    if (!personalEligible(current)) {
      if (names.length) throw assistantProblem("invalid");
      return;
    }
    const added = names.filter((name) => !personalSkills(current).includes(name));
    if (!added.length) return;
    const { skills } = await this.list(current.id);
    for (const name of added) {
      const skill = skills.find((s) => s.name === name);
      if (!skill || ["shadowed", "unavailable"].includes(skill.state))
        throw assistantProblem("skillUnavailable", 409);
    }
  }
}
