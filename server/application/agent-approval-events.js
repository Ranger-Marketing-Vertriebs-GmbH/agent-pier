import { agentNotice } from "./push-notices.js";
import { approvalAudience } from "../features/users/approval-audience.js";
import { actionDecisions, decideMode } from "./push-decisions.js";
import { createHash } from "node:crypto";

// Which approval an agent action asks for, as the push names it.
const subjects = {
  exec: "exec",
  ssh: "ssh",
  sftp: "sftp",
  mail_send: "mail",
  coding_start: "coding",
  session_start: "codingSession",
  memory_write: "memory",
  member_grant: "grant",
  hook_proposal: "hook",
  ssh_access: "sshAccess",
};

// A question's id that is an inbox address (inbox-items.js agentQuestionItem).
const inboxId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

/**
 * The `agent-approval` push: an agent's shell or SSH command, SFTP transfer, email
 * to send, coding task, memory
 * entry, member permission or hook proposal waiting for approval, and a lead's team
 * proposal, and a question an agent asks while its turn waits (subject `question`,
 * assistants/agent-questions.js). It reads the same stores as the inbox
 * (server/features/inbox/inbox-sources.js) on the operations poll, so every path that
 * makes an agent wait is covered. What already waits when AgentPier starts never
 * notifies late; Telegram keeps its own messages.
 *
 * A question notifies once: its key is the runtime's id of the request, which a
 * reconnect, a new listing or a request asked again keeps, and its event id is derived
 * from that id, so the notification service's delivery claim holds across restarts
 * too. Its first question is the preview, which only a device at the preview level
 * gets, shortened and dropped when it looks like a command, a path or a secret
 * (notifications/push-content.js). The question's text is never logged.
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
      // Allow and Deny only on the owner's own items (users decide in their app).
      const decide =
        audience.kind === "user" ? undefined : decideMode(actionDecisions(action));
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
          ...(decide && Number.isSafeInteger(action.revision)
            ? { decide, revision: action.revision }
            : {}),
        },
      });
    }
    for (const question of assistants.questions?.waitingAll() || []) {
      const [first] = question.questions;
      // A question in a user's chat goes to her devices only, never to the owner's.
      const audience = approvalAudience(question, assistants.store);
      items.push({
        key: `question:${question.id}`,
        notice: {
          kind: "agent-approval",
          // The runtime's id may hold what an event id does not take.
          eventId: `agent-question-${createHash("sha256").update(question.id).digest("hex").slice(0, 40)}`,
          subject: "question",
          ...agentNotice(assistants, question.assistantId, question.conversationId),
          // The owner's waits in his inbox too (inbox-items.js agentQuestionItem).
          ...(audience.kind === "user"
            ? { audience }
            : inboxId.test(question.id)
              ? { inbox: { type: "question", id: question.id } }
              : {}),
          ...(first?.text || first?.header
            ? { preview: first.text || first.header }
            : {}),
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
