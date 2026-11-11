import { assistantProblem } from "./assistant-validation.js";
import { shellChange } from "./shell-changes.js";
import { newCapabilities } from "./memory-rules.js";
import { auditProactivity, proactivityChange } from "./proactivity-changes.js";
import { ownProcess } from "./runtimes/runtime-for.js";
import { refuseRuntimeChoice } from "./own-process-agents.js";

// Creation validates the chosen area after asynchronous model/template checks,
// before storing anything. Group assignment never applies runtime configuration.
export async function createAgent(service, body, { userAccess = null } = {}) {
  const {
    confirmShell,
    confirmFull,
    template,
    areaGroupId = null,
    ...input
  } = body || {};
  const origin = template === undefined ? null : await service.templateOrigin(template);
  return service.admit(async () => {
    const base = userAccess ? "off" : "approval",
      level = input.shell ?? base;
    shellChange({ shell: base }, input, { confirmShell, confirmFull });
    // Skills are assigned once the agent exists (agent-skills.js).
    if (input.skills?.length) throw assistantProblem("invalid");
    refuseRuntimeChoice(service.runtime, input, service.accounts);
    const lease = await service.models.resolve(input.model || {});
    lease.release();
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
    service.changed();
    return record;
  });
}
