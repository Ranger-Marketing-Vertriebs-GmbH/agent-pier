import { serverCatalogs } from "../../lib/i18n/catalogs.js";
import { assistantProblem } from "./assistant-validation.js";
import { AgentCardStore } from "./agent-card-store.js";
import { CARD_LIMITS, cardError, cardFallback, cardInput } from "./agent-card-schema.js";
import { plainTurnText, shownTurnText } from "./plain-turn-text.js";

/** What a write tells the agent about who sees the card. */
export const cardNotes = {
  owner:
    "The owner sees this card in the chat now; do not repeat its contents in text. Ticks reach you as a card note with the owner's next message; buttons send a message.",
  user: "The person who asked sees this card in this chat now; do not repeat its contents in text. Ticks reach you as a card note with their next message; buttons send a message.",
};
const cardNote = (conversation) =>
  conversation?.userId ? cardNotes.user : cardNotes.owner;

const keys = {
  create: { required: ["title", "blocks"], optional: [] },
  update: { required: ["cardId", "blocks"], optional: ["title"] },
  read: { required: [], optional: ["cardId"] },
};
function validate(input) {
  const spec =
    input && typeof input === "object" && !Array.isArray(input) && keys[input.action];
  if (
    !spec ||
    Object.keys(input).some(
      (k) => k !== "action" && !spec.required.includes(k) && !spec.optional.includes(k),
    ) ||
    spec.required.some((k) => input[k] === undefined) ||
    ("cardId" in input && typeof input.cardId !== "string")
  )
    throw assistantProblem("invalid");
  return input;
}

/** What the agent reads of a card: its content with the person's ticks. */
export const cardView = (card) => ({
  cardId: card.id,
  title: card.title,
  version: card.version,
  ...(card.frozenAt ? { frozen: true } : {}),
  updatedAt: card.updatedAt,
  blocks: card.blocks,
  ...(card.pressed ? { pressed: card.pressed } : {}),
});

const quoted = (text) => JSON.stringify(text);
const header =
  "[AgentPier card state: what the person changed on cards of this chat since you last saw them; not written by them]";
const cut = "- … more changes: read the cards with agentpier_card";

/**
 * The card note of a turn (agent-cards.js turnNote): one line per card the person
 * changed since the agent last saw it, naming only the checklist items ticked or
 * unticked since then (`card.seenTicks`) and the latest button pressed; at most
 * CARD_LIMITS.note characters. As plain text: no `/` or `!` in an item the agent wrote
 * reaches the Gateway as a command or directive (plain-turn-text.js).
 */
export function cardStateNote(cards) {
  const lines = cards.map((card) => {
    const parts = card.blocks
      .filter((block) => block.type === "checklist")
      .flatMap((block) => {
        const changed = block.items.filter(
          (item) =>
            (card.seenTicks?.[`${block.id}/${item.id}`] ?? false) !== item.checked,
        );
        const named = (checked) =>
          changed
            .filter((item) => item.checked === checked)
            .map((item) => quoted(item.text))
            .join(", ");
        return changed.length
          ? [
              `checklist ${quoted(block.title ?? block.id)}: ${[
                named(true) && `ticked ${named(true)}`,
                named(false) && `unticked ${named(false)}`,
              ]
                .filter(Boolean)
                .join("; ")}`,
            ]
          : [];
      });
    if (card.pressed)
      parts.push(
        `pressed ${quoted(card.pressed.label)}${card.pressed.row ? ` on row ${quoted(card.pressed.row)}` : ""}`,
      );
    return `- card ${quoted(card.title)} (cardId ${card.id}, version ${card.version}): ${parts.join("; ") || "no change left"}`;
  });
  let note = header;
  for (const line of lines) {
    if (note.length + line.length + cut.length + 2 > CARD_LIMITS.note) {
      note += `\n${cut}`;
      break;
    }
    note += `\n${line}`;
  }
  return plainTurnText(note);
}

/**
 * agentpier_card: an agent puts an interactive card into the chat of its current run,
 * built from the closed block set of agent-card-schema.js and rendered by AgentPier
 * (web/features/assistants/cards/). `create` adds a card, `update` replaces an open
 * card's blocks with a new version and moves it to this point of the chat (its old
 * place keeps a marker), `read` returns one card or the chat's cards.
 *
 * The chat is the run's own (AgentShares.turn): the turn's chat, the chat a routine
 * delivers to, the main chat for a hook, or the owner's chat for a run of it without a
 * turn. On a shared agent that is the chat of the person the run belongs to. A card of
 * another chat is CARD_NOT_FOUND, and team members get no cards (CARD_UNAVAILABLE).
 *
 * The person's ticks are saved silently (check); a button records its press and the
 * web app sends its message as the person's own (press). The agent learns of both with
 * the person's next turn (turnNote). Creating a card in a turn from Telegram, or in a
 * routine that delivers to Telegram, queues its text fallback there; updates do not.
 */
export class AgentCards {
  constructor({ assistants, now = () => new Date().toISOString() }) {
    this.assistants = assistants;
    this.now = now;
    this.store = new AgentCardStore(assistants.store.db);
  }

  // The run's chat, request key and origin (AgentShares.turn), or CARD_UNAVAILABLE.
  turn(invocation) {
    const a = this.assistants;
    let turn;
    try {
      turn = a.shares.turn(invocation);
    } catch {
      throw cardError("CARD_UNAVAILABLE", 403);
    }
    const agent = a.store.getAssistant(turn.conversation.assistantId);
    if (agent.archivedAt || agent.teamMemberId || turn.conversation.archivedAt)
      throw cardError("CARD_UNAVAILABLE", 403);
    return { ...turn, agent };
  }

  async invoke(invocation, input) {
    validate(input);
    const a = this.assistants;
    if (a.closed || a.maintenance || a.recovering)
      throw assistantProblem("unavailable", 503);
    const turn = this.turn(invocation);
    const { conversation } = turn;
    const at = this.now();
    if (input.action === "read") {
      const cards = input.cardId
        ? [this.store.inChat(conversation.id, input.cardId)]
        : this.store.forConversation(conversation.id);
      // Only a card read whole is seen; the list names titles, not ticks.
      if (input.cardId) this.store.seen(cards, at);
      return input.cardId
        ? { status: "ok", card: cardView(cards[0]) }
        : {
            status: "ok",
            cards: cards.map(({ id, title, version, frozenAt, updatedAt }) => ({
              cardId: id,
              title,
              version,
              ...(frozenAt ? { frozen: true } : {}),
              updatedAt,
            })),
          };
    }
    const previous =
      input.action === "update" ? this.store.inChat(conversation.id, input.cardId) : null;
    const content = cardInput(
      { title: input.title ?? previous?.title, blocks: input.blocks },
      previous,
    );
    // A routine that creates a card every run piles them up: it updates one instead.
    if (
      !previous &&
      this.store.createdSince(
        conversation.id,
        new Date(Date.parse(at) - 3600000).toISOString(),
      ) >= CARD_LIMITS.createsPerHour
    )
      throw cardError("CARD_RATE_LIMIT", 429, CARD_LIMITS.createsPerHour);
    invocation.assertCurrent?.();
    const placed = { requestId: turn.requestId, at };
    const card = previous
      ? this.store.update(previous, { ...content, ...placed })
      : this.store.create({
          assistantId: turn.agent.id,
          conversationId: conversation.id,
          ...content,
          ...placed,
        });
    const telegram = previous ? null : this.telegram(turn, card);
    this.audit(turn.agent, input.action);
    a.changed?.({ conversationId: conversation.id });
    return {
      status: previous ? "updated" : "created",
      cardId: card.id,
      version: card.version,
      ...(telegram ? { telegram } : {}),
      note: cardNote(conversation),
    };
  }

  // Queues the card's text for the run's Telegram chat; the card stands without it.
  telegram(turn, card) {
    const shares = this.assistants.shares;
    const channels = shares?.channels;
    const target = "target" in turn ? turn.target : shares?.target(turn.origin);
    if (!target || !channels) return null;
    try {
      const channel = channels.store.get(target.channelId);
      const m = (serverCatalogs[channel?.language] || serverCatalogs.de).agentCards;
      channels.outbox.enqueue({
        key: `card:${card.id}`,
        source: target,
        kind: "agent-card",
        localized: true,
        text: cardFallback(card, m.telegram),
      });
      return "queued";
    } catch {
      return "unavailable";
    }
  }

  // The card of a chat the person may change now: neither chat nor agent archived.
  open(conversationId, cardId) {
    const a = this.assistants;
    if (a.closed || a.maintenance || a.recovering)
      throw assistantProblem("unavailable", 503);
    const conversation = a.store.getConversation(conversationId);
    const agent = a.store.getAssistant(conversation.assistantId);
    if (conversation.archivedAt || agent.archivedAt)
      throw cardError("CARD_UNAVAILABLE", 403);
    return this.store.inChat(conversationId, cardId);
  }

  /** The person ticks a checklist item of a card of chat `conversationId`. */
  check(conversationId, cardId, body) {
    const card = this.open(conversationId, cardId);
    const next = this.store.check(card, { ...addressOf(body), at: this.now() });
    this.assistants.changed?.({ conversationId });
    return cardView(next);
  }

  /**
   * The person presses a button of a card of chat `conversationId`: the press is
   * remembered for the agent's next turn; `text` is the message the web app sends,
   * as plain text (no word the agent wrote runs as a chat command), and `at` names
   * the press for `unpress`.
   */
  press(conversationId, cardId, body) {
    const card = this.open(conversationId, cardId);
    const at = this.now();
    const { card: next, text } = this.store.press(card, { ...addressOf(body), at });
    this.assistants.changed?.({ conversationId });
    return { text: plainTurnText(text), at, card: cardView(next) };
  }

  /** The press at `body.at` sent no message (the send failed): forget it. */
  unpress(conversationId, cardId, body) {
    if (typeof body?.at !== "string" || body.at.length > 40)
      throw assistantProblem("invalid");
    const card = this.store.inChat(conversationId, cardId);
    const next = this.store.unpress(card, body.at);
    this.assistants.changed?.({ conversationId });
    return cardView(next);
  }

  /**
   * The chat history's cards (conversations.js): each card at its latest place, and a
   * marker at each place it held before (`cardMoved`), each with the request it was
   * placed by, so the owner-privacy window hides it like a shared file.
   */
  notesFor(conversationId) {
    return this.store.forConversation(conversationId).flatMap((card) =>
      card.placements.map((placement, index) => {
        const base = {
          id: `card:${card.id}:${card.version - card.placements.length + index + 1}`,
          role: "assistant",
          text: "",
          timestamp: Date.parse(placement.at),
          runId: null,
          requestId: placement.requestId,
        };
        return index === card.placements.length - 1
          ? {
              ...base,
              card: {
                id: card.id,
                title: card.title,
                version: card.version,
                updatedAt: card.updatedAt,
                frozen: !!card.frozenAt,
                blocks: card.blocks,
              },
            }
          : { ...base, cardMoved: { id: card.id, title: card.title } };
      }),
    );
  }

  /**
   * The card note for the next turn of chat `conversationId`, or null when the person
   * changed no card since the agent last saw it: `{ note, cards, at }`, the cards as
   * the note names them and its time.
   */
  turnNote(conversationId) {
    const at = this.now();
    const cards = this.store.changedFor(conversationId);
    return cards.length ? { note: cardStateNote(cards), cards, at } : null;
  }

  /** The turn `request` carries `note`: kept to strip it from the history. */
  noted(request, conversation, note) {
    this.store.recordNote({
      conversationId: conversation.id,
      requestId: request.id,
      assistantId: conversation.assistantId,
      note,
    });
  }

  /**
   * The agent received `found` (turnNote): it has seen its cards as they were then; a
   * tick or press made since stays for the next note.
   */
  delivered(found) {
    this.store.seen(found.cards, found.at);
  }

  /** The history's user messages without the card notes their turns carried. */
  withoutNotes(conversationId, messages) {
    const notes = this.store.notes(conversationId);
    if (!notes.length) return messages;
    return messages.map((message) => {
      if (message.role !== "user" || typeof message.text !== "string") return message;
      // The note as sent, or as the history shows it without the joiners.
      const note = notes
        .flatMap((n) => [n, shownTurnText(n)])
        .find((n) => message.text === n || message.text.endsWith(`\n\n${n}`));
      return note
        ? { ...message, text: message.text.slice(0, -note.length).trimEnd() }
        : message;
    });
  }

  audit(agent, action) {
    try {
      this.assistants.audit?.append({
        action: "assistant.updated",
        resourceType: "assistant",
        resourceId: agent.id,
        source: "system",
        outcome: "success",
        details: { kind: "card", card: action },
      });
    } catch {
      /* The write stands; the audit log reports its own failures. */
    }
  }
}

// The card version and place a tick or press names (owner and /me routes).
function addressOf(body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw assistantProblem("invalid");
  const { version, block, item, row, checked } = body;
  if (
    !Number.isInteger(version) ||
    !Number.isInteger(block) ||
    (row !== undefined && !Number.isInteger(row)) ||
    (item !== undefined && typeof item !== "string" && !Number.isInteger(item)) ||
    (checked !== undefined && typeof checked !== "boolean")
  )
    throw assistantProblem("invalid");
  return { version, block, item, row, checked };
}
