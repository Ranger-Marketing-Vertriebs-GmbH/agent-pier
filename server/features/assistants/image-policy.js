import { personalCapabilities } from "./native-capabilities.js";

// Each agent may start this many image generations per UTC day; status and list
// reads never count. A constant on purpose: one bounded budget per agent.
export const DAILY_IMAGE_LIMIT = 30;
const keys = new Set(["agentId", "sessionKey", "action", "remote"]);
const refuse = (reason) => ({ allow: false, reason });

/**
 * AgentPier's answer to the plugin's image_generate hook (tool-guard.js imageCall):
 * the calling agent must hold Create images now (its own switch, or its lead's grant
 * for a task member), a reference from the web needs Read web pages as well, and
 * every generation counts against the agent's daily limit. Each one is audited with
 * its count, never its prompt.
 */
export class ImagePolicy {
  constructor({ assistants, now = Date.now }) {
    Object.assign(this, { assistants, now });
    this.db = assistants.store.db;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS assistant_image_usage (assistant_id TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (assistant_id, day))",
    );
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
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const used =
      this.db
        .prepare("SELECT count FROM assistant_image_usage WHERE assistant_id=? AND day=?")
        .get(agent.id, day)?.count || 0;
    if (used >= DAILY_IMAGE_LIMIT) return refuse("limit");
    this.db
      .prepare(
        "INSERT INTO assistant_image_usage VALUES (?,?,1) ON CONFLICT(assistant_id, day) DO UPDATE SET count=count+1",
      )
      .run(agent.id, day);
    // Earlier days are not needed once a new one started.
    this.db
      .prepare("DELETE FROM assistant_image_usage WHERE assistant_id=? AND day<?")
      .run(agent.id, day);
    try {
      this.assistants.audit?.append({
        action: "assistant.executed",
        resourceType: "assistant",
        resourceId: agent.id,
        source: "system",
        outcome: "success",
        details: { kind: "image-generation", count: used + 1 },
      });
    } catch {
      /* The call stands; the audit log reports its own failures. */
    }
    return { allow: true };
  }
}
