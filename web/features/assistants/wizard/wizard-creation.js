// "Agent anlegen" (handoff 5.3): the agent first, then its capabilities, access and
// MCP grants, team policy, Telegram, check-ins and its first routine, each through
// the endpoint its settings tab uses and with the revision it reads right before.
// A failed later step keeps the agent; nothing is ever sent again on its own.
import { confirmationRequest } from "../../../lib/settings/save-chain.js";
import { switchKeys } from "./wizard-draft.js";

const web = switchKeys.filter((key) => key !== "memory" && key !== "reminders");

/** The steps of one creation, in order; only what the draft asks for. */
export function creationPlan(d) {
  const user = Boolean(d.owner);
  const work =
    (!user &&
      (d.projectIds.length ||
        d.pipelineIds.length ||
        d.autonomous ||
        d.publish ||
        d.sshAccesses.length ||
        d.github ||
        d.secretIds.length)) ||
    Object.keys(d.projectFiles).length;
  return [
    "create",
    ...(web.some((key) => d[key]) || d.skills.length ? ["capabilities"] : []),
    ...(work ? ["access"] : []),
    ...(d.mcpServers.length ? ["mcp"] : []),
    ...(!user && d.team ? ["team"] : []),
    ...(!user && d.telegramToken.trim() ? ["telegram"] : []),
    ...(!user && d.heartbeatEnabled && d.memory ? ["heartbeat"] : []),
    ...(!user && d.routine ? ["routine"] : []),
  ];
}

/** The POST body of the agent itself: web tools come with the capabilities step. */
export function createBody(d) {
  const body = {
    name: d.name.trim(),
    instructions: d.instructions,
    model: { connectionId: d.connectionId, modelId: d.modelId.trim() },
    capabilities: {
      memory: d.memory,
      reminders: d.reminders,
      ...Object.fromEntries(web.map((key) => [key, false])),
    },
    ...(d.template && { template: { id: d.template.id, revision: d.template.revision } }),
  };
  if (d.owner)
    return {
      ...body,
      userAccess: { mode: d.kind, members: [{ userId: d.owner, level: "chat" }] },
    };
  return d.shell !== "off" ? { ...body, shell: d.shell } : body;
}

const workAccess = (d, revision) =>
  d.owner
    ? { revision, projectFiles: d.projectFiles }
    : {
        revision,
        projectIds: d.projectIds,
        pipelineIds: d.pipelineIds,
        memoryWrite: false,
        autonomous: d.autonomous,
        publish: d.publish,
        projectFiles: d.projectFiles,
        sshAccesses: d.sshAccesses,
        github: d.github,
        secretIds: d.secretIds,
      };

const routineTrigger = (time, tz) => {
  const [hours, minutes] = time.split(":").map(Number);
  return { kind: "cron", expr: `${minutes} ${hours} * * *`, tz };
};

/**
 * One step's request. `api` holds the endpoints; `agent` is the created agent
 * ({ id }); `revision(kind)` reads the current revision of the agent ("assistant"),
 * its access record ("access") or team policy ("team").
 */
export async function runCreationStep(
  step,
  { d, api, agent, revision, flags = {}, env },
) {
  if (step === "create")
    return d.owner
      ? api.createUserAgent({ ...createBody(d) })
      : api.create({ ...createBody(d), ...flags });
  const id = agent.id;
  if (step === "capabilities")
    return api.update(id, {
      capabilities: Object.fromEntries(switchKeys.map((key) => [key, d[key] === true])),
      ...(d.skills.length && !d.owner ? { skills: d.skills } : {}),
      revision: await revision("assistant"),
      ...flags,
    });
  if (step === "access")
    return api.saveWork(id, { access: workAccess(d, await revision("access")) });
  if (step === "mcp")
    return api.update(id, {
      mcpServers: d.mcpServers,
      revision: await revision("assistant"),
      ...flags,
    });
  if (step === "team")
    return api.saveWork(id, { team: { ...d.team, revision: await revision("team") } });
  if (step === "telegram")
    return api.createChannel({
      assistantId: id,
      token: d.telegramToken.trim(),
      appUrl: env.origin,
      language: env.language,
    });
  if (step === "heartbeat")
    return api.update(id, {
      heartbeat: {
        enabled: true,
        interval: d.heartbeatInterval,
        start: d.heartbeatStart,
        end: d.heartbeatEnd,
        timeZone: d.heartbeatTimeZone,
        telegram: d.heartbeatTelegram,
      },
      revision: await revision("assistant"),
    });
  if (step === "routine")
    return api.createRoutine(id, {
      // The same id on a retry: the server never creates the routine twice.
      clientRequestId: env.routineRequestId,
      name: d.routine.name.trim(),
      prompt: d.routine.prompt.trim(),
      trigger: routineTrigger(d.routine.time, d.heartbeatTimeZone),
      ...(d.routine.telegram && d.telegramToken.trim() ? { telegram: true } : {}),
    });
  throw new Error(`Unknown creation step ${step}`);
}

/**
 * Runs the plan's steps that are not done yet (`results[step].status !== "done"`),
 * in order, or only `only` (a retry). A confirmation the server asks for (shell,
 * full shell, stdio MCP server, restart) goes to `ask(request)`; refusing it fails
 * that step without sending. A failed agent stops everything; a failed later step
 * keeps the agent and the next steps still run. Returns { agent, results }.
 */
export async function runCreation({
  plan,
  d,
  api,
  ask,
  env,
  results = {},
  agent = null,
  only = null,
  onProgress = () => {},
}) {
  const next = { ...results };
  let created = agent;
  const revision = (kind) => api.revision(created.id, kind);
  for (const step of plan) {
    if (only ? step !== only : next[step]?.status === "done") continue;
    if (step !== "create" && !created) break;
    let flags = {};
    next[step] = { status: "running" };
    onProgress({ agent: created, results: { ...next } });
    for (;;) {
      try {
        const result = await runCreationStep(step, {
          d,
          api,
          agent: created,
          revision,
          flags,
          env,
        });
        if (step === "create") created = result;
        next[step] = { status: "done" };
        break;
      } catch (error) {
        const request = confirmationRequest(error);
        const repeated =
          request &&
          Object.entries(request.flags).every(([key, value]) => flags[key] === value);
        if (request && !repeated && (await ask(request))) {
          flags = { ...flags, ...request.flags };
          continue;
        }
        next[step] = {
          status: "failed",
          error: request && !repeated ? "" : error?.message || "",
        };
        break;
      }
    }
    onProgress({ agent: created, results: { ...next } });
    if (step === "create" && next.create.status !== "done") break;
  }
  return { agent: created, results: next };
}
