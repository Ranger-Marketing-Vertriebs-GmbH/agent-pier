// Pure rules of the new agent wizard (handoff 5.3): its draft, its steps, what a
// duplicate copies (5.3.1) and what the summary names. No request is made here.
import { shellLevel } from "../shell-level.js";
import {
  sortedGrants,
  sortedIds,
  sortedLevels,
} from "../settings/agent-settings-fields.js";
import { profileSwitches } from "./wizard-profiles.js";

export const wizardSteps = [
  "start",
  "identity",
  "capabilities",
  "access",
  "channels",
  "review",
];
// Zugriffe and Kanäle & Routinen may be skipped.
export const optionalSteps = new Set(["access", "channels"]);
export const switchKeys = [
  "memory",
  "reminders",
  "webSearch",
  "webFetch",
  "documents",
  "readPdfs",
  "browser",
  "createImages",
];

/** The draft of a blank agent: profile "Rechercheur" preselected, nothing granted. */
export function emptyDraft(timeZone = "UTC") {
  return {
    start: "blank",
    owner: "",
    kind: "own",
    template: null,
    duplicateOf: "",
    name: "",
    instructions: "",
    connectionId: "",
    modelId: "",
    profile: "research",
    ...profileSwitches("research"),
    skills: [],
    projectIds: [],
    projectFiles: {},
    pipelineIds: [],
    autonomous: false,
    publish: false,
    mcpServers: [],
    sshAccesses: [],
    github: null,
    secretIds: [],
    team: null,
    telegramToken: "",
    heartbeatEnabled: false,
    heartbeatInterval: "4h",
    heartbeatStart: 9,
    heartbeatEnd: 18,
    heartbeatTimeZone: timeZone,
    heartbeatTelegram: true,
    // { name, prompt, time "HH:MM", telegram } once "Erste Routine" is switched on.
    routine: null,
  };
}

/**
 * What "Duplizieren" takes from an agent (handoff 5.3.1), and nothing else:
 * instructions (name "Kopie von <Name>"), model, capability switches, shell level,
 * enabled bundled skills, access grants (projects with levels, pipelines and their
 * two switches, MCP servers, SSH with mode, GitHub level and token profile, secrets)
 * and the team policy. Memory, chats, attachments, Telegram, hooks, reminders,
 * routines, the shell allowlist, the browser profile, users and the template's
 * provenance stay behind. `policy` is its access record, `team` its team policy.
 */
export function duplicateFields(agent, policy, team, copyName) {
  const capabilities = agent.capabilities || {};
  return {
    name: copyName(agent.name || ""),
    instructions: agent.instructions || "",
    connectionId: agent.model?.connectionId || "",
    modelId: agent.model?.modelId || "",
    ...Object.fromEntries(switchKeys.map((key) => [key, capabilities[key] === true])),
    shell: shellLevel(agent),
    skills: sortedIds(agent.skills),
    projectIds: sortedIds(policy?.projectIds),
    projectFiles: sortedLevels(policy?.projectFiles),
    pipelineIds: sortedIds(policy?.pipelineIds),
    autonomous: policy?.autonomous === true,
    publish: policy?.publish === true,
    mcpServers: sortedIds(agent.mcpServers),
    sshAccesses: sortedGrants(policy?.sshAccesses),
    github: policy?.github
      ? { credentialId: policy.github.credentialId, level: policy.github.level }
      : null,
    secretIds: sortedIds(policy?.secretIds),
    team: team
      ? {
          usage: team.usage,
          autonomous: team.autonomous === true,
          memberShellSsh: team.memberShellSsh === true,
          maxMembers: team.maxMembers,
          runTimeoutMinutes: team.runTimeoutMinutes,
        }
      : null,
  };
}

/** Whether the draft holds any access grant (step 4). */
export const hasAccess = (d) =>
  d.projectIds.length > 0 ||
  Object.keys(d.projectFiles).length > 0 ||
  d.pipelineIds.length > 0 ||
  d.mcpServers.length > 0 ||
  d.sshAccesses.length > 0 ||
  Boolean(d.github) ||
  d.secretIds.length > 0;

/** An agent of a user gets no shell, coding, pipelines, SSH, GitHub, secrets or teams. */
export function forUserAgent(d) {
  if (!d.owner) return d;
  return {
    ...d,
    shell: "off",
    projectIds: [],
    pipelineIds: [],
    autonomous: false,
    publish: false,
    sshAccesses: [],
    github: null,
    secretIds: [],
    team: null,
    telegramToken: "",
    heartbeatEnabled: false,
    routine: null,
  };
}

/** The steps a step's "Weiter" needs; "" when it may move on. */
export function stepProblem(step, d) {
  if (step === "start" && d.start === "template" && !d.template) return "template";
  if (step === "start" && d.start === "duplicate" && !d.duplicateOf) return "duplicate";
  if (step === "identity") {
    if (!d.name.trim()) return "name";
    if (!d.connectionId || !d.modelId.trim()) return "model";
  }
  if (step === "channels" && d.routine) {
    if (!d.routine.name.trim() || !d.routine.prompt.trim()) return "routine";
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.routine.time)) return "routineTime";
  }
  return "";
}

/** The first step whose problem blocks creating, or "" when every step is complete. */
export const firstProblem = (d) => wizardSteps.find((step) => stepProblem(step, d)) || "";
