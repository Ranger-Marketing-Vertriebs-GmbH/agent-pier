import { Router } from "express";
import {
  sessionDeviceAccess,
  setSessionDeviceAccess,
} from "../../features/devices/session-device-access.js";
import { answering } from "./devices.js";

/**
 * The Android devices one coding session may use, for the owner only
 * (features/devices/session-device-access.js, where the answer is described):
 *
 *   GET /api/sessions/:id/devices   200, the session's device access
 *   PUT /api/sessions/:id/devices   200, the same after the change; the body is
 *                                   `{ devices: [{ deviceId, manage }], create }`
 *
 * The same value is the live topic `session.devices:<session id>`. A launch takes
 * the body of the PUT as `deviceAccess` (POST /api/sessions). A refusal answers
 * `{ code, error: code }`: DEVICE_ASSIGNMENT_INVALID (400) for another shape or an
 * unknown device, DEVICE_SESSION_INELIGIBLE (409) for a session that cannot be given
 * devices; an unknown session is the session routes' 404.
 */
export function sessionDevicesRoutes(services) {
  const router = Router();
  router.use("/sessions/:id/devices", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get(
    "/sessions/:id/devices",
    answering(async (req, res) => {
      res.json(sessionDeviceAccess(services, await services.sessions.get(req.params.id)));
    }),
  );
  router.put(
    "/sessions/:id/devices",
    answering(async (req, res) => {
      const session = await services.sessions.get(req.params.id);
      // Nothing at all is not "no access": the body names both fields.
      res.json(setSessionDeviceAccess(services, session, req.body ?? null));
    }),
  );
  return router;
}
