import { Router } from "express";
import { messageIdentity } from "../../lib/i18n/message-identity.js";
import { settingsPatch, settingsView } from "../../features/users/user-agent-settings.js";
import { isShared } from "../../features/users/user-access.js";
import { userProblem } from "../../features/users/user-errors.js";

const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * A user's settings and memory of her agents, within her level (user-agent-settings.js).
 * Each handler resolves the agent through the user scope first.
 */
export function meAgentSettingsRoutes({ assistants, assistantMemory, userScope, audit }) {
  const router = Router();
  const mine = (req) => {
    const agent = userScope.agentOf(req.principal, req.params.id);
    return { agent, level: userScope.level(agent.id, req.principal.userId) };
  };
  router.get("/me/agents/:id/settings", (req, res) => {
    const { agent, level } = mine(req);
    res.json(settingsView(agent, level));
  });
  router.patch("/me/agents/:id/settings", async (req, res) => {
    const { agent, level } = mine(req);
    const { values, revision } = record(req.body) ? req.body : {};
    const patch = settingsPatch(agent, level, values);
    try {
      await assistants.update(agent.id, patch, revision);
    } catch (error) {
      // New web tools would restart the Gateway for everyone: only the owner decides.
      if (error?.code !== "ASSISTANT_RESTART_REQUIRED") throw error;
      return res.status(409).json({
        code: error.code,
        error: error.message,
        ...messageIdentity(error.message),
      });
    }
    // Who changed which fields; never the instructions or any other value.
    audit.append({
      action: "assistant.updated",
      resourceType: "assistant",
      resourceId: agent.id,
      outcome: "success",
      source: "user",
      actorUserId: req.principal.userId,
      details: { fields: Object.keys(patch) },
    });
    const { agent: saved } = mine(req);
    res.json(settingsView(saved, level));
  });
  router.get("/me/agents/:id/memory", async (req, res) =>
    res.json(await assistantMemory.files(mine(req).agent.id)),
  );
  router.get("/me/agents/:id/memory/:name", async (req, res) =>
    res.json(await assistantMemory.read(mine(req).agent.id, req.params.name)),
  );
  // Her own agent's notes, from "personalize" on; shared memory stays the owner's.
  router.delete("/me/agents/:id/memory/:name", async (req, res) => {
    const { agent, level } = mine(req);
    if (isShared(agent) || !["personalize", "extended"].includes(level))
      throw userProblem("USER_LEVEL");
    await assistantMemory.remove(agent.id, req.params.name);
    res.status(204).end();
  });
  return router;
}
