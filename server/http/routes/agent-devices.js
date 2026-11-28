import { Router } from "express";
import {
  agentDeviceAccess,
  deviceAgentRecord,
  setAgentDeviceAccess,
} from "../../features/devices/agent-device-access.js";
import { assistantErrors } from "./assistant-workflows.js";
import { answering } from "./devices.js";

/**
 * The Android devices one agent may use, for the owner only
 * (features/devices/agent-device-access.js, where the answer is described):
 *
 *   GET /api/assistants/:id/devices   200, the agent's device access
 *   PUT /api/assistants/:id/devices   200, the same after the change; the body is
 *                                     `{ devices: [{ deviceId, manage }], create }`
 *
 * The same value is the live topic `agent.devices:<agent id>`. A refusal answers
 * `{ code, error: code }`: DEVICE_ASSIGNMENT_INVALID (400) for another shape or an
 * unknown device, DEVICE_AGENT_INELIGIBLE (409) for an agent that cannot be given
 * devices (archived, an agent of restricted users, or one with its own bot for other
 * people). An unknown agent is a 404 like the other agent routes'.
 */
export function agentDevicesRoutes(services) {
  const router = Router();
  router.use("/assistants/:id/devices", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get(
    "/assistants/:id/devices",
    answering(async (req, res) => {
      res.json(agentDeviceAccess(services, deviceAgentRecord(services, req.params.id)));
    }),
  );
  router.put(
    "/assistants/:id/devices",
    answering(async (req, res) => {
      const agent = deviceAgentRecord(services, req.params.id);
      res.json(setAgentDeviceAccess(services, agent, req.body));
    }),
  );
  router.use("/assistants/:id/devices", assistantErrors);
  return router;
}
