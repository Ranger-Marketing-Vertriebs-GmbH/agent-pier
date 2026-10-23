import { longContext } from "./conversations.js";
import { memberLongChatText } from "./lead-request-text.js";
import { reappearsAt } from "./long-chats.js";
import { editableMember } from "./member-reach.js";
import { mainConversation } from "./routine-targets.js";

/**
 * The table of lead hints, per member task chat: the size the lead was told at and
 * how that note's delivery stands (private: operations/private-tables.js).
 */
export const memberLongChatTable =
  "CREATE TABLE IF NOT EXISTS assistant_member_long_chats (conversation_id TEXT PRIMARY KEY, member_id TEXT NOT NULL, tokens INTEGER NOT NULL, window INTEGER, delivery TEXT NOT NULL, failures INTEGER NOT NULL, retry_at INTEGER NOT NULL, told_at TEXT NOT NULL)";
// Busy or unavailable lead chats are retried with backoff, as member results are.
const delivery = { attempts: 5, baseMs: 2000, maxMs: 120000 };

/**
 * The long-chat hint for a lead (AGENTPIER-194): the owner does not read its members'
 * chats, so once a turn settles in a member's task chat (`member.conversationId`, the
 * member's main chat) and the chat is long by the UI's rule (conversations.js
 * longContext), the lead gets one note in its main chat (`member-long-chat`, attributed
 * data) and decides whether to have it summarised. It hears again only once the chat
 * grew as a hidden hint must (long-chats.js reappearsAt), or after a summary made it
 * smaller. Further chats the owner opened with the member, agents that are no member,
 * archived members and members whose summary after their task is pending get none.
 */
export class MemberLongChats {
  constructor({ teams, assistants }) {
    Object.assign(this, { teams, assistants });
    this.db = assistants.store.db;
    this.db.exec(memberLongChatTable);
    this.delivering = new Set();
    this.failing = new Set();
    this.now = () => Date.now();
    // Whether a summary after the member's task is pending (member-summaries.js).
    this.summaryPending = () => false;
  }
  /** The token size the lead was last told at for the task chat, or null. */
  told(conversationId) {
    return this.row(conversationId)?.tokens ?? null;
  }
  /** Forgets the hint of the task chat: its next long size tells the lead again. */
  clear(conversationId) {
    this.db
      .prepare("DELETE FROM assistant_member_long_chats WHERE conversation_id=?")
      .run(conversationId);
  }
  row(conversationId) {
    return this.db
      .prepare("SELECT * FROM assistant_member_long_chats WHERE conversation_id=?")
      .get(conversationId);
  }
  /** The lead's own non-archived member whose task chat this is, or null. */
  memberOf(conversationId) {
    const member = this.teams.members().find((m) => m.conversationId === conversationId);
    if (!member || !editableMember(member, member.parentAssistantId)) return null;
    try {
      const lead = this.assistants.store.getAssistant(member.parentAssistantId);
      return lead.archivedAt ? null : member;
    } catch {
      return null;
    }
  }
  /** Checks the chat after a turn of it settled (run-reconciler.js). */
  async check(conversationId) {
    const a = this.assistants;
    if (!this.memberOf(conversationId)) return;
    const client = a.runtime.client;
    if (!client?.ready || a.maintenance || a.recovering || a.closed) return;
    const conversation = a.store.getConversation(conversationId);
    // OpenClaw 2026.10.3 reports the session's size with any history page.
    const { sessionInfo: info } = await client.call("chat.history", {
      sessionKey: conversation.runtimeSessionKey,
      limit: 1,
    });
    if (info?.totalTokensFresh !== true || !Number.isFinite(info.totalTokens)) return;
    const member = this.memberOf(conversationId);
    if (!member || this.summaryPending(member.id)) return;
    let told = this.told(conversationId);
    // Smaller than when the lead was told: summarised meanwhile.
    if (told !== null && info.totalTokens < told) {
      this.clear(conversationId);
      told = null;
    }
    if (!longContext(info)) return;
    if (told !== null && info.totalTokens < reappearsAt(told)) return;
    // A summary that runs already needs no decision.
    if (a.longChats?.compacting(conversationId)) return;
    this.db
      .prepare(
        "INSERT OR REPLACE INTO assistant_member_long_chats VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        conversationId,
        member.id,
        info.totalTokens,
        Number.isFinite(info.contextTokens) ? info.contextTokens : null,
        "pending",
        0,
        0,
        new Date(this.now()).toISOString(),
      );
    await this.deliver(conversationId);
  }
  /** Delivers the notes still waiting for their lead's chat (team-service.js). */
  async tick() {
    const rows = this.db
      .prepare(
        "SELECT conversation_id FROM assistant_member_long_chats WHERE delivery='pending'",
      )
      .all();
    for (const { conversation_id: id } of rows)
      try {
        await this.deliver(id);
        this.failing.delete(id);
      } catch (error) {
        // One note must not hold back the others or reject the team tick; its
        // failure is logged once until it delivers.
        if (this.failing.has(id)) continue;
        this.failing.add(id);
        console.warn(`Telling the lead about chat ${id} failed: ${error?.message}`);
      }
  }
  /**
   * Sends the note into the lead's main chat once that chat has no turn underway, as
   * LeadRequests.deliver does; its stable client id adopts a note already admitted.
   */
  async deliver(conversationId) {
    const a = this.assistants;
    const row = this.row(conversationId);
    if (!row || row.delivery !== "pending" || this.delivering.has(conversationId)) return;
    if (this.now() < row.retry_at) return;
    const member = this.memberOf(conversationId);
    const leadChat = member && mainConversation(a.store, member.parentAssistantId);
    // Nobody was told: a later long size tells again.
    if (!leadChat || this.summaryPending(member.id)) return this.clear(conversationId);
    if (
      a.ledger
        .pending()
        .some((x) => a.ledger.getRequest(x.requestId).conversationId === leadChat.id)
    )
      return;
    this.delivering.add(conversationId);
    const settle = (patch) =>
      this.db
        .prepare(
          "UPDATE assistant_member_long_chats SET delivery=?, failures=?, retry_at=? WHERE conversation_id=? AND tokens=?",
        )
        .run(patch.delivery, patch.failures, patch.retryAt, conversationId, row.tokens);
    try {
      await a.send(
        leadChat.id,
        {
          clientRequestId: `member-long-chat:${conversationId}:${row.tokens}`,
          text: memberLongChatText({
            memberId: member.id,
            memberName: member.name || a.store.getAssistant(member.assistantId).name,
            tokens: row.tokens,
            window: row.window,
          }),
        },
        { kind: "member-long-chat", memberId: member.id },
      );
      settle({ delivery: "sent", failures: row.failures, retryAt: 0 });
      a.changed?.();
    } catch (error) {
      const failures = row.failures + 1;
      if (failures >= delivery.attempts || ![409, 503].includes(error?.status))
        settle({ delivery: "failed", failures, retryAt: 0 });
      else
        settle({
          delivery: "pending",
          failures,
          retryAt: this.now() + Math.min(delivery.baseMs * 2 ** failures, delivery.maxMs),
        });
    } finally {
      this.delivering.delete(conversationId);
    }
  }
}
