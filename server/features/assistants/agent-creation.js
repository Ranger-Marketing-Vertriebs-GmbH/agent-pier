import { assistantProblem } from "./assistant-validation.js";
import { shellChange } from "./shell-changes.js";
import { newCapabilities } from "./memory-rules.js";
import { auditProactivity, proactivityChange } from "./proactivity-changes.js";
import { ownProcess } from "./runtimes/runtime-for.js";
import { refuseRuntimeChoice } from "./own-process-agents.js";
import { validateRuntimeOptions } from "./runtimes/runtime-options.js";

// Creation validates the chosen area after asynchronous model/template checks,
// before storing anything. Group assignment never applies runtime configuration.
export async function createAgent(service, body, { userAccess = null } = {}) {
  const {
    confirmShell,
    confirmFull,
    confirmRestart,
    template,
    areaGroupId = null,
    ...input
  } = body || {};
  const origin = template === undefined ? null : await service.templateOrigin(template);
  let restart = false;
  const record = await service.admit(async () => {
    const base = userAccess ? "off" : "approval",
      level = input.shell ?? base;
    shellChange({ shell: base }, input, { confirmShell, confirmFull });
    // Skills are assigned once the agent exists (agent-skills.js).
    if (input.skills?.length) throw assistantProblem("invalid");
    refuseRuntimeChoice(service.runtime, input, service.accounts);
    // A duplicate's options for its runtime, checked by that runtime against an agent
    // that stores none yet, so every advisor must be available now.
    if (input.runtimeOptions !== undefined) {
      const { runtimeOptions: _given, ...created } = input;
      // A user's own agent is checked as one (no memory wiki for it).
      input.runtimeOptions = validateRuntimeOptions(
        { ...created, ...(userAccess && { userAccess }) },
        input.runtimeOptions,
        { models: service.models },
      );
    }
    const lease = await service.models.resolve(input.model || {});
    lease.release();
    // Options that need a plugin the running Gateway did not load (the first memory
    // wiki): queued in the app, else confirmed and restarted once created
    // (assistant-service.js update does the same).
    const needs =
      !!input.runtimeOptions &&
      Object.keys(input.runtimeOptions).length > 0 &&
      !!service.webTools?.optionsDiffer(
        [
          ...service.store.listAssistants(),
          { ...input, id: "new", ...(userAccess && { userAccess }) },
        ],
        input,
      );
    const queued = needs && !!service.webTools.pending;
    if (needs && !queued)
      service.webTools.confirm(confirmRestart === true, "runtimeOptionsRestartRequired");
    restart = needs && !queued;
    // Memory on by default, web capabilities off (memory-rules.js).
    const capabilities = newCapabilities(input, service.dreaming?.enabled());
    // Check-ins are switched on in the saved agent (its settings), not at creation.
    const heartbeat = input.heartbeat && { ...input.heartbeat, enabled: false };
    const record = service.agentGroups.transaction(() => {
      if (areaGroupId !== null) service.agentGroups.get(areaGroupId);
      const record = service.store.createAssistant(
        {
          ...input,
          shell: level,
          capabilities,
          ...(heartbeat && { heartbeat }),
        },
        (origin || userAccess) && {
          ...(origin && { template: origin }),
          ...(userAccess && { userAccess }),
        },
      );
      if (areaGroupId !== null)
        service.agentGroups.assignInside(record.id, {
          groupId: areaGroupId,
          previousGroupId: null,
        });
      return record;
    });
    // The Gateway gets the agent, and its level, at its first apply.
    if (level !== "off")
      service.shellChanges.audit(record.id, { from: "off", to: level }, {});
    auditProactivity(service.audit, record.id, proactivityChange({}, record));
    // A Hermes agent's set starts now (in the background), OpenClaw's at first apply.
    if (ownProcess(record)) service.config.apply(record.id).catch(() => {});
    if (queued) service.webTools.queue("runtimeOptions");
    service.changed();
    return record;
  });
  // Maintenance drains the admission lock, so the restart runs after it.
  if (restart)
    await service.webTools.restart(() => service.store.getAssistant(record.id));
  return record;
}
