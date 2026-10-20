import { Router } from "express";
import { boundTo } from "../../features/assistants/reminder-audience.js";
import { userProblem } from "../../features/users/user-errors.js";

const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
// A user's reminder goes to her chat; Telegram extras are her agent's to pair (later).
const ownInput = (body) => {
  if (!record(body)) return body;
  const { channelId: _channel, telegram: _telegram, ...rest } = body;
  return rest;
};

/**
 * A user's own reminders and routines on her agents: she sees hers at every level and
 * creates, changes and deletes them from "personalize" on. Another user's on a shared
 * agent are not found.
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
    const own = (req) => {
      const id = mine(req, true);
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
      res.json(await service.update(own(req), req.params.bindingId, ownInput(req.body))),
    );
    router.delete(`${base}/:bindingId`, async (req, res) =>
      res.json(await service.remove(own(req), req.params.bindingId)),
    );
  }
  return router;
}
