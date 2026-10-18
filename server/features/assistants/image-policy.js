import { personalCapabilities } from "./native-capabilities.js";

const keys = new Set(["agentId", "sessionKey", "action", "remote"]);
const refuse = (reason) => ({ allow: false, reason });

/**
 * AgentPier's answer to the plugin's image_generate hook (tool-guard.js imageCall):
 * the calling agent must hold Create images now (its own switch, or its lead's grant
 * for a task member) and a reference from the web needs Read web pages as well.
 * There is no daily limit (AGENTPIER-134); each generation is audited, never with its
 * prompt. Databases from before keep their unused assistant_image_usage table.
 */
export class ImagePolicy {
  constructor({ assistants }) {
    this.assistants = assistants;
  }
  check(input) {
    if (
      !input ||
      typeof input !== "object" ||
      Object.keys(input).some((key) => !keys.has(key)) ||
      typeof input.agentId !== "string" ||
      typeof input.remote !== "boolean" ||
      (input.action !== undefined && typeof input.action !== "string")
    )
      return refuse("unavailable");
    const agent = this.assistants.store
      .listAssistants()
      .find((profile) => profile.runtimeAgentId === input.agentId);
    if (!agent || agent.archivedAt) return refuse("unavailable");
    const capabilities = personalCapabilities(agent);
    if (!capabilities.createImages) return refuse("notGranted");
    if (input.remote && !capabilities.webFetch) return refuse("remote");
    if ((input.action ?? "generate") !== "generate") return { allow: true };
    try {
      this.assistants.audit?.append({
        action: "assistant.executed",
        resourceType: "assistant",
        resourceId: agent.id,
        source: "system",
        outcome: "success",
        details: { kind: "image-generation" },
      });
    } catch {
      /* The call stands; the audit log reports its own failures. */
    }
    return { allow: true };
  }
}
