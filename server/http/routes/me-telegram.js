import { Router } from "express";
import { isShared } from "../../features/users/user-access.js";
import { userProblem } from "../../features/users/user-errors.js";
import { mainConversation } from "../../features/assistants/routine-targets.js";

const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
// What she sees of her bot: never its token, nor anything of other chats.
const view = (channel) =>
  channel && {
    id: channel.id,
    username: channel.username,
    enabled: channel.enabled === true,
    paired: !!channel.chatId,
    pairingExpiresAt: channel.pairingExpiresAt ?? null,
    language: channel.language,
    revision: channel.revision,
  };

/**
 * An Extended user connects her own agent's Telegram bot to her main chat. Shared
 * agents and lower levels are refused (USER_LEVEL); the bot token never leaves.
 */
export function meTelegramRoutes({ assistants, assistantChannels: channels, userScope }) {
  const router = Router();
  const mine = (req) => {
    const agent = userScope.agentOf(req.principal, req.params.id);
    if (isShared(agent) || userScope.level(agent.id, req.principal.userId) !== "extended")
      throw userProblem("USER_LEVEL");
    return agent;
  };
  // Her agent's bot, the one delivering into her own main chat.
  const channelOf = (agent, userId) => {
    const chat = mainConversation(assistants.store, agent.id, userId);
    return (
      (chat &&
        channels.store
          .list()
          .find((c) => c.assistantId === agent.id && c.conversationId === chat.id)) ||
      null
    );
  };
  const body = (req) => (record(req.body) ? req.body : {});
  router.get("/me/agents/:id/telegram", (req, res) => {
    const agent = mine(req);
    res.json({ channel: view(channelOf(agent, req.principal.userId)) });
  });
  router.put("/me/agents/:id/telegram", async (req, res) => {
    const agent = mine(req);
    const { token, language } = body(req);
    const current = channelOf(agent, req.principal.userId);
    const channel = current
      ? await channels.update(current.id, { token, revision: current.revision })
      : await channels.create(
          { assistantId: agent.id, token, ...(language && { language }) },
          { userId: req.principal.userId },
        );
    res.json({ channel: view(channels.store.get(channel.id)) });
  });
  router.post("/me/agents/:id/telegram/pair", async (req, res) => {
    const agent = mine(req);
    const current = channelOf(agent, req.principal.userId);
    if (!current) throw userScope.refusal();
    const { appUrl, language } = body(req);
    const { code, url, expiresAt } = await channels.pair(
      current.id,
      current.revision,
      appUrl,
      language,
    );
    res.json({ code, url, expiresAt });
  });
  router.delete("/me/agents/:id/telegram", async (req, res) => {
    const agent = mine(req);
    const current = channelOf(agent, req.principal.userId);
    if (!current) throw userScope.refusal();
    await channels.disconnect(current.id, current.revision);
    res.json({ channel: view(channels.store.get(current.id)) });
  });
  return router;
}
