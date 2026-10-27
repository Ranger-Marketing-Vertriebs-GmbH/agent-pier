import { agentNotice } from "./push-notices.js";
import { approvalAudience } from "../features/users/approval-audience.js";

// Which approval an agent action asks for, as the push names it.
const subjects = {
  exec: "exec",
  ssh: "ssh",
  coding_start: "coding",
  session_start: "codingSession",
  memory_write: "memory",
  member_grant: "grant",
  hook_proposal: "hook",
  ssh_access: "sshAccess",
};

/**
 * The `agent-approval` push: an agent's shell or SSH command, coding task, memory
 * entry, member permission or hook proposal waiting for approval, and a lead's team
 * proposal. It reads the same stores as the inbox (server/features/inbox/
 * inbox-sources.js) on the operations poll, so every path that makes an agent wait is
 * covered. What already waits when AgentPier starts never notifies late; Telegram keeps
 * its own messages.
 */
export class AgentApprovalEvents {
  constructor({ services, notifications, onError = () => {}, now = Date.now }) {
    Object.assign(this, { services, notifications, onError, now });
    this.seen = null;
  }
  waiting() {
    const assistants = this.services.assistants;
    if (!assistants || assistants.closed) return null;
    const items = [];
    for (const action of assistants.workflows?.store.awaiting(this.now()) || []) {
      const subject = subjects[action.payload?.action];
      if (!subject) continue;
      // A user's approval goes to her devices only, never into the owner's inbox.
      const audience = approvalAudience(action, assistants.store);
      items.push({
        key: `action:${action.id}`,
        notice: {
          kind: "agent-approval",
          eventId: `agent-action-${action.id}`,
          subject,
          ...agentNotice(assistants, action.assistantId, action.conversationId),
          ...(audience.kind === "user"
            ? { audience }
            : { inbox: { type: "action", id: action.id } }),
        },
      });
    }
    for (const team of assistants.teams?.store.list() || []) {
      if (team.phase !== "awaiting_approval" || team.archivedAt) continue;
      items.push({
        key: `team:${team.id}`,
        notice: {
          kind: "agent-approval",
          eventId: `agent-team-${team.id}`,
          subject: "team",
          ...agentNotice(assistants, team.parentAssistantId, team.parentConversationId),
          inbox: { type: "team", id: team.id },
          // The team's goal is its preview.
          ...(team.objective ? { preview: team.objective } : {}),
        },
      });
    }
    return items;
  }
  async poll() {
    let items;
    try {
      items = this.waiting();
    } catch (error) {
      this.onError(error);
      return;
    }
    if (!items) return;
    const keys = new Set(items.map((item) => item.key));
    const first = this.seen === null;
    const fresh = first ? [] : items.filter((item) => !this.seen.has(item.key));
    this.seen = keys;
    for (const { notice } of fresh)
      await this.notifications.notify(notice).catch(this.onError);
  }
}
