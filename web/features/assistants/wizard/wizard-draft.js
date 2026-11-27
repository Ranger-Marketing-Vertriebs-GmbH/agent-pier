// Pure rules of the new agent wizard (handoff 5.3): its draft, its steps, what a
// duplicate copies (5.3.1) and what the summary names. No request is made here.
import { offersEveryCommand, offersReview, shellChoice } from "../shell-level.js";
import { traitOf } from "../runtime-traits.js";
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
    // The runtime a duplicate keeps; empty lets the server choose its default.
    runtime: "",
    name: "",
    areaGroupId: null,
    instructions: "",
    connectionId: "",
    modelId: "",
    profile: "research",
    ...profileSwitches("research"),
    skills: [],
    // "Learns its own skills": null leaves the runtime's default; a duplicate carries
    // its source's choice where that differs from it.
    skillLearning: null,
    // A duplicate's options for its runtime (`{ [runtime]: object }`), else null.
    runtimeOptions: null,
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
    // Checking in on its own is what makes an agent act; it needs memory.
    heartbeatEnabled: true,
    heartbeatInterval: "30m",
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
 * its runtime, instructions (name "Kopie von <Name>"), model, capability switches, shell level,
 * enabled bundled skills, whether it learns its own skills, its runtime's own options
 * (runtimeOptions of the runtime it runs on), access grants (projects with levels, pipelines and their
 * two switches, MCP servers, SSH with mode, GitHub level and token profile, secrets)
 * and the team policy. Memory, chats, attachments, Telegram, hooks, reminders,
 * routines, the shell allowlist, the browser profile, users and the template's
 * provenance stay behind. `policy` is its access record, `team` its team policy.
 */
export function duplicateFields(agent, policy, team, copyName) {
  const capabilities = agent.capabilities || {};
  return {
    runtime: agent.runtime || "",
    name: copyName(agent.name || ""),
    instructions: agent.instructions || "",
    connectionId: agent.model?.connectionId || "",
    modelId: agent.model?.modelId || "",
    ...Object.fromEntries(switchKeys.map((key) => [key, capabilities[key] === true])),
    shell: shellChoice(agent),
    skills: sortedIds(agent.skills),
    skillLearning:
      typeof agent.skillLearning === "boolean" &&
      agent.skillLearning !== traitOf(agent.runtimeInfo, "skills", "learnsByDefault")
        ? agent.skillLearning
        : null,
    runtimeOptions: ownRuntimeOptions(agent),
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

// The agent's options for the runtime it runs on, as a create body takes them.
function ownRuntimeOptions(agent) {
  const runtime = agent.runtimeInfo?.id ?? agent.runtime;
  const options = runtime ? agent.runtimeOptions?.[runtime] : undefined;
  return options && Object.keys(options).length ? { [runtime]: options } : null;
}

/**
 * The draft fields for runtime `runtime` ("" lets the server choose its default),
 * whose view is `runtimeInfo` (runtime-list.js runtimeInfoOf). On a runtime without
 * the "Every command" shell level that choice becomes "With approval", and on one
 * that needs a ChatGPT login AgentPier holds (runtime-capabilities.js modelsFor)
 * another chosen login is cleared. While the view is unknown (the runtime list has
 * not arrived) nothing the owner chose is taken back: the server refuses what the
 * runtime cannot run.
 */
export const withRuntime = (d, runtime, models = [], runtimeInfo) => ({
  runtime,
  // A duplicate's runtime options belong to its source's runtime alone.
  ...(d.runtimeOptions && !Object.hasOwn(d.runtimeOptions, runtime)
    ? { runtimeOptions: null }
    : {}),
  // The default runtime's levels are the defaults, known without its view.
  ...((runtimeInfo || !runtime) && !offersEveryCommand(runtimeInfo) && d.shell === "every"
    ? { shell: "approval" }
    : {}),
  // A level with a model review falls back to asking the owner where it is missing.
  ...(runtimeInfo && !offersReview(runtimeInfo) && d.shell === "review"
    ? { shell: "approval" }
    : {}),
  // Such a runtime keeps a chosen ChatGPT login only when AgentPier holds it.
  ...(runtimeInfo &&
  traitOf(runtimeInfo, "models", "chatgptLogin") === "agentpierHeld" &&
  d.connectionId?.startsWith("openclaw:") &&
  models.find((m) => m.id === d.connectionId)?.holder !== "agentpier"
    ? { connectionId: "", modelId: "" }
    : {}),
});

/** Whether the draft holds any access grant (step 4). */
export const hasAccess = (d) =>
  d.projectIds.length > 0 ||
  Object.keys(d.projectFiles).length > 0 ||
  d.pipelineIds.length > 0 ||
  d.mcpServers.length > 0 ||
  d.sshAccesses.length > 0 ||
  Boolean(d.github) ||
  d.secretIds.length > 0;

/**
 * An agent of a user gets no shell, coding, pipelines, SSH, GitHub, secrets or teams,
 * and learns its own skills only where its runtime lets users' agents learn
 * (`runtimeInfo`, the draft's runtime view; the server refuses it elsewhere).
 */
export function forUserAgent(d, runtimeInfo) {
  if (!d.owner) return d;
  return {
    ...d,
    ...(d.skillLearning === true &&
      !traitOf(runtimeInfo, "skills", "userAgentsLearn") && { skillLearning: null }),
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
