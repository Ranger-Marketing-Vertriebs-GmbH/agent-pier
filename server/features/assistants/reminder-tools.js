import { inheritsFromLead, personalCapabilities } from "./native-capabilities.js";
import { assistantProblem } from "./assistant-validation.js";
import { exact } from "./reminder-input.js";
import { pairedChannel } from "./routine-targets.js";
import { boundTo, turnAudience } from "./reminder-audience.js";
// Reminders all task members of one team may create together on their lead.
export const memberReminderLimit = 5;
/** The agent's reminder tool (agentpier_reminder) for one turn. */
export function invokeReminder(self, invocation, input) {
  invocation.assertCurrent();
  exact(input, ["action", "name", "message", "schedule", "id", "enabled", "revision"]);
  const request = self.assistants.ledger.getRequest(
    self.assistants.ledger.getAttempt(invocation.attemptId).requestId,
  );
  const conversation = self.assistants.store.getConversation(request.conversationId);
  const origin = self.assistants.teams.store.context(request.id);
  const caller = self.assistants.store.getAssistant(conversation.assistantId);
  if (inheritsFromLead(caller))
    return memberCreate(self, caller, invocation, input, origin);
  // The person whose chat the turn is in owns what it creates (reminder-audience.js).
  const userId = turnAudience(caller, conversation, origin, input?.action !== "list");
  self.agent(conversation.assistantId, true);
  if (input.action === "list") return self.list(conversation.assistantId, { userId });
  if (["update", "remove"].includes(input.action))
    boundTo(self.bindings, conversation.assistantId, input.id, userId);
  if (input.action === "create")
    return self.create(
      conversation.assistantId,
      {
        clientRequestId: `${invocation.attemptId}:${invocation.toolCallId}`,
        name: input.name,
        message: input.message,
        schedule: input.schedule,
      },
      origin,
      invocation.assertCurrent,
      userId ? { userId } : {},
    );
  if (input.action === "remove")
    return self.remove(conversation.assistantId, input.id, invocation.assertCurrent);
  if (input.action === "update")
    return self.update(
      conversation.assistantId,
      input.id,
      {
        enabled: input.enabled,
        revision: input.revision,
      },
      invocation.assertCurrent,
    );
  throw assistantProblem("invalid");
}
/**
 * A temporary member's reminder belongs to its lead: it is created on the lead,
 * listed in the lead's settings and delivered to the lead's paired chat, so it never
 * fires from an agent that has ended. A member can only create one, in a turn its
 * lead gave it, while it holds reminders; listing, pausing and removing stay
 * with the owner and the lead.
 */
export async function memberCreate(self, member, invocation, input, origin) {
  if (
    self.kind !== "reminder" ||
    !["team-member", "lead-request"].includes(origin.kind) ||
    input.action !== "create" ||
    !personalCapabilities(member).reminders
  )
    throw assistantProblem("invalid", 403);
  const lead = member.parentAssistantId,
    key = `${invocation.attemptId}:${invocation.toolCallId}`;
  const own = self.bindings.list(lead);
  const replay = own.some((b) => b.key === key);
  // At most a few per team, so a steered member cannot flood the owner's chat.
  if (
    !replay &&
    own.filter((b) => b.createdBy?.teamId === member.teamId && b.state !== "removed")
      .length >= memberReminderLimit
  )
    throw assistantProblem("memberReminderLimit", 409);
  const result = await self.create(
    lead,
    {
      clientRequestId: key,
      name: input.name,
      message: input.message,
      schedule: input.schedule,
      // Also to the lead's Telegram chat when it has one, as before chat delivery.
      telegram: !!pairedChannel(self.channels, lead),
    },
    null,
    invocation.assertCurrent,
    { createdBy: { teamId: member.teamId, memberId: member.teamMemberId } },
  );
  // Noted in the lead's chat and audited, never with the reminder's text.
  if (!replay) self.assistants.teams?.grants?.reminderCreated?.(member);
  return result;
}
