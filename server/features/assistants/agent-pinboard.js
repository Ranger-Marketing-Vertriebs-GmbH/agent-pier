import { assistantProblem, textValue } from "./assistant-validation.js";
import { AgentPinboardStore, PINBOARD_LIMITS } from "./agent-pinboard-store.js";
import { AgentPinboardView } from "./agent-pinboard-view.js";
import { openPinned, pinIdentity, pinType } from "./agent-pinboard-files.js";
import { mainConversation } from "./routine-targets.js";
import { isUserAgent } from "../users/user-access.js";

/** What a pin tells the agent about who sees the list. */
export const pinboardNote =
  "The owner sees this list on your pinboard now; do not repeat the file's contents unless asked.";

const L = PINBOARD_LIMITS;
// The tool schema's keys (team-plugin/pinboard-tool.js) and the ones each action needs.
const fields = {
  listId: [100],
  title: [L.title],
  description: [L.description, true],
  path: [4096],
  projectId: [100],
  name: [L.name],
  note: [L.note, true],
  entryId: [100],
};
const needs = {
  list: [],
  create_list: ["title"],
  update_list: ["listId"],
  pin: ["listId", "path"],
  unpin: ["listId"],
  reorder: ["listId", "entryIds"],
  archive_list: ["listId"],
  reopen_list: ["listId"],
  delete_list: ["listId"],
};

function validate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw assistantProblem("invalid");
  if (!Object.hasOwn(needs, input.action)) throw assistantProblem("invalid");
  for (const [key, value] of Object.entries(input)) {
    if (key === "action") continue;
    if (key === "entryIds") {
      if (
        !Array.isArray(value) ||
        value.length > L.entries ||
        value.some((id) => typeof id !== "string" || id.length > 100)
      )
        throw assistantProblem("invalid");
    } else if (fields[key]) textValue(value, ...fields[key]);
    else throw assistantProblem("invalid");
  }
  if (needs[input.action].some((key) => !(key in input)))
    throw assistantProblem("invalid");
  if (input.action === "unpin" && !("entryId" in input) && !("name" in input))
    throw assistantProblem("invalid");
  return input;
}

const basename = (name) => name.slice(0, L.name);

/**
 * agentpier_pinboard: an agent keeps named lists of links to files for the owner,
 * beside the chat (the owner's view: agent-pinboard-view.js). Entries name a file in
 * the agent's workspace or a granted project folder; pinning resolves it with the
 * share rules of the calling turn, routine or hook (as agentpier_share_file), and
 * stores the path as resolved then. Nothing is copied.
 *
 * Owner-only: every action is refused in a restricted user's chat and on a user's own
 * agent. A member pins onto its own board. A pin or unpin leaves one card per list and
 * turn in the chat (store.recordChange); list-level actions only signal the board.
 */
export class AgentPinboard {
  constructor({ assistants, onChange = () => {} }) {
    this.assistants = assistants;
    this.onChange = onChange;
    this.store = new AgentPinboardStore(assistants.store.db);
    this.viewer = new AgentPinboardView({
      assistants,
      store: this.store,
      onChange: (id) => this.onChange(id),
    });
  }

  view(assistantId) {
    return this.viewer.view(assistantId);
  }
  seen(assistantId, entryId) {
    return this.viewer.seen(assistantId, entryId);
  }
  open(assistantId, entryId) {
    return this.viewer.file(assistantId, entryId);
  }
  // The pinboard cards of a chat's history.
  notesFor(conversationId) {
    return this.viewer.notesFor(conversationId);
  }

  async invoke(invocation, input) {
    validate(input);
    const a = this.assistants;
    // No workspace reads while a restore or update may replace them.
    if (a.closed || a.maintenance || a.recovering)
      throw assistantProblem("unavailable", 503);
    const turn = a.shares.turn(invocation);
    const agent = a.store.getAssistant(turn.conversation.assistantId);
    if (agent.archivedAt) throw assistantProblem("invalid", 403);
    if (
      (isUserAgent(agent) && agent.userAccess.mode === "own") ||
      typeof turn.conversation.userId === "string"
    )
      throw assistantProblem("pinboardOwnerOnly", 403);
    const ctx = { invocation, input, agent, ...turn, now: new Date().toISOString() };
    if (input.action === "list") return this.list(agent);
    const result = await {
      create_list: () => this.createList(ctx),
      update_list: () => this.updateList(ctx),
      pin: () => this.pin(ctx),
      unpin: () => this.unpin(ctx),
      reorder: () => this.reorder(ctx),
      archive_list: () => this.archiveList(ctx),
      reopen_list: () => this.reopenList(ctx),
      delete_list: () => this.deleteList(ctx),
    }[input.action]();
    this.audit(agent, input);
    this.onChange(agent.id);
    return result;
  }

  list(agent) {
    return {
      status: "ok",
      lists: this.store.lists(agent.id).map((list) => ({
        id: list.id,
        title: list.title,
        description: list.description,
        archived: !!list.archivedAt,
        entries: list.entries.map(({ id, name, note, version }) => ({
          id,
          name,
          note,
          version,
        })),
      })),
    };
  }

  createList({ agent, input, conversation, now }) {
    const list = this.store.createList(
      agent.id,
      {
        title: input.title.trim(),
        description: input.description?.trim() ?? "",
        originConversationId: conversation.id,
      },
      now,
    );
    this.assistants.changed?.();
    return {
      status: "created",
      list: { id: list.id, title: list.title },
      note: pinboardNote,
    };
  }

  updateList({ agent, input, now }) {
    const list = this.store.updateList(
      agent.id,
      input.listId,
      { title: input.title?.trim(), description: input.description?.trim() },
      now,
    );
    this.assistants.changed?.();
    return {
      status: "updated",
      list: { id: list.id, title: list.title, description: list.description },
    };
  }

  async pin(ctx) {
    const { agent, input, invocation, conversation, now } = ctx;
    const list = this.store.getList(agent.id, input.listId);
    const root = input.projectId ? `project:${input.projectId}` : "workspace";
    const opened = await openPinned(
      this.assistants,
      agent,
      { root, path: input.path },
      {
        admit: (relative) => this.assistants.shares.admit(agent, conversation, relative),
        scope: input.projectId ? { invocation, conversation } : null,
      },
    );
    let pinned;
    try {
      const identity = {
        ...(await pinIdentity(opened.handle, opened.stat)),
        ...(await pinType(opened.handle, opened.size, opened.name)),
      };
      invocation.assertCurrent?.();
      if (list.archivedAt) this.store.setArchived(agent.id, list.id, false, now);
      pinned = this.store.pin(
        agent.id,
        list.id,
        {
          name: input.name?.trim() || basename(opened.name),
          note: input.note?.trim() ?? "",
          root,
          // The file as resolved now: owner reads refuse any other way to it.
          path: opened.relative,
          admitConversationId: conversation.id,
          identity,
        },
        now,
      );
    } finally {
      await opened.handle.close();
    }
    const { entry, replaced } = pinned;
    const current = this.store.getList(agent.id, list.id);
    this.card(ctx, current, replaced ? "updated" : "added", entry.name);
    return {
      status: replaced ? "replaced" : "pinned",
      list: { id: current.id, title: current.title, entries: current.entries.length },
      entry: { id: entry.id, name: entry.name, version: entry.version },
      note: pinboardNote,
    };
  }

  unpin(ctx) {
    const { agent, input } = ctx;
    const entry = this.store.unpin(agent.id, input.listId, {
      entryId: input.entryId,
      name: input.entryId === undefined ? input.name : undefined,
    });
    this.card(ctx, this.store.getList(agent.id, input.listId), "removed", entry.name);
    return { status: "unpinned", entry: { id: entry.id, name: entry.name } };
  }

  reorder({ agent, input }) {
    this.store.reorder(agent.id, input.listId, input.entryIds);
    this.assistants.changed?.();
    return { status: "reordered" };
  }

  archiveList({ agent, input, now }) {
    this.store.setArchived(agent.id, input.listId, true, now);
    this.assistants.changed?.();
    return { status: "archived" };
  }

  reopenList({ agent, input, now }) {
    this.store.setArchived(agent.id, input.listId, false, now);
    this.assistants.changed?.();
    return { status: "reopened" };
  }

  deleteList({ agent, input }) {
    this.store.deleteList(agent.id, input.listId);
    this.assistants.changed?.();
    return { status: "deleted" };
  }

  // The chat a card goes to: the turn's own, else the list's origin chat while it is
  // open, else the agent's main chat.
  cardChat({ invocation, conversation, agent }, list) {
    if (invocation.attemptId) return conversation.id;
    const origin = this.viewer.conversation(list.originConversationId);
    if (origin && !origin.archivedAt) return origin.id;
    return mainConversation(this.assistants.store, agent.id)?.id ?? null;
  }

  card(ctx, list, kind, name) {
    const conversationId = this.cardChat(ctx, list);
    if (conversationId)
      this.store.recordChange({
        conversationId,
        requestId: ctx.requestId,
        listId: list.id,
        assistantId: ctx.agent.id,
        title: list.title,
        at: ctx.now,
        kind,
        name,
      });
    this.assistants.changed?.(conversationId ? { conversationId } : undefined);
  }

  audit(agent, input) {
    try {
      this.assistants.audit?.append({
        action: "assistant.updated",
        resourceType: "assistant",
        resourceId: agent.id,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        source: "system",
        outcome: "success",
        details: { kind: "pinboard", pinboard: input.action },
      });
    } catch {
      /* The write stands; the audit log reports its own failures. */
    }
  }
}
