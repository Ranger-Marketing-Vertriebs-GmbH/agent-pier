import { Router } from "express";
import { boundTo } from "../../features/assistants/reminder-audience.js";
import { userProblem } from "../../features/users/user-errors.js";

const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
// A user's reminder goes to her chat; Telegram extras are her agent's to pair (later).
// "May write" lets a routine change project files: that switch is the owner's alone.
const ownInput = (body) => {
  if (!record(body)) return body;
  const { channelId: _channel, telegram: _telegram, writes: _writes, ...rest } = body;
  return rest;
};

// Pausing ({ enabled: false } and the revision, nothing else) only stops what she set
// up, so it stays hers at every level, like deleting.
const pauseOnly = (body) =>
  record(body) &&
  body.enabled === false &&
  Object.keys(body).every((key) => key === "enabled" || key === "revision");

/**
 * A user's own reminders and routines on her agents: she sees, pauses and deletes hers
 * at every level, so a lowering to Chat only never leaves them running out of her
 * reach, and creates and changes them from "personalize" on. Another user's on a
 * shared agent are not found.
 */
export function meReminderRoutes({ userScope, assistantReminders, assistantRoutines }) {
  const router = Router();
  const mine = (req, write = false) => {
    const agent = userScope.agentOf(req.principal, req.params.id);
    if (write && userScope.level(agent.id, req.principal.userId) === "chat")
      throw userProblem("USER_LEVEL");
    return agent.id;
  };
  for (const [kind, service] of [
    ["reminders", assistantReminders],
    ["routines", assistantRoutines],
  ]) {
    const base = `/me/agents/:id/${kind}`;
    const own = (req, stop = false) => {
      const id = mine(req, !stop);
      boundTo(service.bindings, id, req.params.bindingId, req.principal.userId);
      return id;
    };
    router.get(base, async (req, res) =>
      res.json(await service.list(mine(req), { userId: req.principal.userId })),
    );
    router.post(base, async (req, res) =>
      res.status(201).json(
        await service.create(mine(req, true), ownInput(req.body), null, undefined, {
          userId: req.principal.userId,
        }),
      ),
    );
    router.patch(`${base}/:bindingId`, async (req, res) =>
      res.json(
        await service.update(
          own(req, pauseOnly(req.body)),
          req.params.bindingId,
          ownInput(req.body),
        ),
      ),
    );
    router.delete(`${base}/:bindingId`, async (req, res) =>
      res.json(await service.remove(own(req, true), req.params.bindingId)),
    );
  }
  return router;
}
