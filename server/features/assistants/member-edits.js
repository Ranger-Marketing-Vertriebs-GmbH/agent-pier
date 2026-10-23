import { randomUUID } from "node:crypto";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { exact } from "./assistant-access.js";
import { leadsMember } from "./member-reach.js";
import { memberModelInput, validateMemberModel } from "./member-models.js";
import {
  extraEnd,
  extraSection,
  extraStart,
  temporaryMember,
} from "./team-presentation.js";
import { dropText, readText, saveText } from "./team-texts.js";

// The fields a lead may change, in the order notes and the audit name them.
export const editFields = [
  "name",
  "role",
  "assignment",
  "extraInstructions",
  "instructions",
];
const limits = {
  name: 100,
  role: 200,
  assignment: 8192,
  extraInstructions: 8192,
  instructions: 65536,
};
const kept = 50;
// Replaced instructions the owner can still read in full; older entries keep none.
const keptTexts = 5;
const textName = (id) => `replaced:${id}`;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const section = new RegExp(
  `\\n*${escape(extraStart)}\\n[\\s\\S]*?\\n${escape(extraEnd)}`,
);
const block = ({ role, assignment }) => `Role: ${role}\nAssignment: ${assignment}`;
const ids = ({ connectionId, modelId }) => ({ connectionId, modelId });
const sameModel = (a, b) =>
  a?.connectionId === b?.connectionId && a?.modelId === b?.modelId;

/**
 * `text` with the lead's composed Role and Assignment block replaced by `next`. The
 * old block (`old`, whole, so a multi-line assignment too) counts only where it
 * starts a line and ends the text or a paragraph; the last such occurrence before the
 * lead's own section is the composed one, as the lead's snapshot comes first. Without
 * one (the owner rewrote it) a fresh block goes before that section, edits nothing.
 */
function setBlock(text, old, next) {
  const extraAt = text.lastIndexOf(`\n\n${extraStart}\n`);
  const head = extraAt < 0 ? text : text.slice(0, extraAt),
    tail = extraAt < 0 ? "" : text.slice(extraAt);
  const find = old.role === undefined ? "" : block(old);
  for (let at = find ? head.lastIndexOf(find) : -1; at >= 0;) {
    const end = at + find.length;
    if (
      (at === 0 || head[at - 1] === "\n") &&
      (end === head.length || head.startsWith("\n\n", end))
    )
      return `${head.slice(0, at)}${block(next)}${head.slice(end)}${tail}`;
    at = at ? head.lastIndexOf(find, at - 1) : -1;
  }
  const before = head.trimEnd();
  return `${before ? `${before}\n\n` : ""}${block(next)}${tail}`;
}

/**
 * The member's current instructions with the lead's change applied: the composed
 * Role and Assignment block replaced (or a fresh one added) and the lead's own
 * delimited section replaced (or appended, or removed when empty). Everything else,
 * the lead's snapshot and any text the owner wrote, stays as it is.
 */
export function editedInstructions(current, member, changes) {
  let text = current;
  const extra = "extraInstructions" in changes;
  if (extra) text = text.replace(section, "");
  if ("role" in changes || "assignment" in changes)
    text = setBlock(text, member, {
      role: changes.role ?? member.role,
      assignment: changes.assignment ?? member.assignment,
    });
  if (extra && changes.extraInstructions) text += extraSection(changes.extraInstructions);
  return text;
}

/** The whole instructions a lead's edit replaced, for the owner's member history. */
export function replacedInstructions(teams, memberId, entryId) {
  const member = teams.member(memberId);
  const text =
    member.grantLog?.some((entry) => entry.replaced === entryId) &&
    readText(teams.db, member.id, textName(entryId));
  if (typeof text !== "string") throw assistantProblem("notFound", 404);
  return { text };
}

/** The log with `entry` added; replaced texts beyond the last few are dropped. */
function nextLog(teams, member, entry) {
  const log = [...(member.grantLog || []), entry].slice(-kept);
  const keep = new Set(
    log
      .filter((e) => e.replaced)
      .slice(-keptTexts)
      .map((e) => e.replaced),
  );
  for (const old of member.grantLog || [])
    if (old.replaced && !keep.has(old.replaced))
      dropText(teams.db, member.id, textName(old.replaced));
  return log.map(({ replaced, ...e }) =>
    replaced && keep.has(replaced) ? { ...e, replaced } : e,
  );
}

/**
 * A lead's edits of its own task members (agentpier_team_member_update): name, role,
 * assignment and an extra instructions section change the member's current
 * instructions in place; `instructions` replaces them whole, whatever the owner
 * wrote before (owner's decision: the lead may rewrite them completely). Owner edits
 * never block the lead. The result is recorded as the lead's (`leadInstructions`),
 * so only later owner edits count as overrides. The replaced text of the last few
 * edits stays readable for the owner alone (replacedInstructions), in a text row of
 * its own beside the member record, never in what the lead sees. Every change is
 * visible: the member's log (team card), a note in both chats and an audit
 * that names the fields only. The member's next turn applies the new revision.
 * `model` moves the member to a model the owner can run now (validateMemberModel);
 * the member's record keeps it as the lead's (`leadModel`), so only later owner
 * changes count as overrides, and a temporary member keeps it as its own.
 */
export class MemberEdits {
  constructor({ teams, assistants, audit = null, onChanged = () => {} }) {
    Object.assign(this, { teams, assistants, audit, onChanged });
  }
  async update(inv, input) {
    exact(input, ["memberId", ...editFields, "model"]);
    if (!("model" in input)) return this.updateNow(inv, input);
    // Who may change it comes first: no model is resolved for a member the lead
    // cannot edit (updateNow checks it all again after the awaits).
    this.target(inv, input.memberId);
    const models = this.assistants.models;
    const chosen = await validateMemberModel(models, memberModelInput(input.model));
    return this.updateNow(inv, input, { ...chosen, previous: await this.label(input) });
  }
  // The caller's lead and the member it edits, or the refusal; synchronous.
  target(inv, memberId) {
    return leadsMember(this.assistants, this.teams, inv, memberId);
  }
  // The member's model before the change, named as the owner reads it (ids for one
  // that no longer resolves); null when the member is not found (updateNow refuses).
  async label({ memberId }) {
    let model;
    try {
      model = this.assistants.store.getAssistant(
        this.teams.member(memberId).assistantId,
      ).model;
    } catch {
      return null;
    }
    const display = await validateMemberModel(this.assistants.models, model).then(
      (named) => named.display,
      () => ({ connection: model.connectionId, model: model.modelId }),
    );
    return { ...ids(model), display };
  }
  // `chosen` is the checked model of the call (update), with the one it replaces.
  updateNow(inv, input, chosen = null) {
    exact(input, ["memberId", ...editFields, ...(chosen ? ["model"] : [])]);
    const changes = {};
    for (const key of editFields)
      if (key in input)
        changes[key] =
          key === "extraInstructions"
            ? textValue(input[key], limits[key], true).trim()
            : key === "instructions"
              ? textValue(input[key], limits[key])
              : textValue(input[key], limits[key]).trim();
    if (!Object.keys(changes).length && !chosen) throw assistantProblem("invalid");
    // A whole rewrite says everything itself; an extra section on top is ambiguous.
    if ("instructions" in changes && "extraInstructions" in changes)
      throw assistantProblem("invalid");
    const a = this.assistants,
      { conversation, lead, member } = this.target(inv, input.memberId);
    const agent = a.store.getAssistant(member.assistantId);
    const current = { ...member, name: agent.name, instructions: agent.instructions };
    // A field the lead restates counts when its text is gone from the instructions
    // (the owner removed it), so restating restores it.
    const edited = editFields.filter(
      (key) =>
        key in changes &&
        (changes[key] !== (current[key] ?? "") ||
          (["role", "assignment", "extraInstructions"].includes(key) &&
            editedInstructions(agent.instructions, member, { [key]: changes[key] }) !==
              agent.instructions)),
    );
    // A member following the lead runs on its model already; the lead's choice of
    // that same model pins it, so the member keeps it when the lead's model changes.
    const following = temporaryMember(agent) && !agent.ownModel;
    const model = chosen && (following || !sameModel(agent.model, chosen)) && ids(chosen);
    const changed = model ? [...edited, "model"] : edited;
    // What the owner reads: the names of both models (ids for an old one gone since).
    const models = model && {
      from: sameModel(chosen.previous, agent.model)
        ? chosen.previous.display
        : { connection: agent.model.connectionId, model: agent.model.modelId },
      to: chosen.display,
    };
    if (!changed.length) return { status: "unchanged", memberId: member.id, changed };
    const instructions =
      "instructions" in changes
        ? changes.instructions
        : editedInstructions(agent.instructions, member, changes);
    const next = this.teams.transaction(() => {
      const saved = a.store.updateAssistant(
        agent.id,
        {
          ...(changes.name !== undefined ? { name: changes.name } : {}),
          ...(instructions !== agent.instructions ? { instructions } : {}),
          // A temporary member keeps it as its own model (AssistantStore, ownModel).
          ...(model ? { model } : {}),
        },
        agent.revision,
      );
      const entry = {
        at: new Date().toISOString(),
        by: "lead",
        edited: changed,
        ...(models ? { model: models } : {}),
      };
      // What the change replaced, for the owner alone (replacedInstructions).
      if (instructions !== agent.instructions) {
        entry.replaced = randomUUID();
        saveText(this.teams.db, member.id, textName(entry.replaced), agent.instructions);
      }
      const stored = edited.filter((key) => key !== "instructions");
      return this.teams.write(member, {
        ...Object.fromEntries(stored.map((key) => [key, changes[key] || undefined])),
        ...(model ? { leadModel: model } : {}),
        leadInstructions: saved.instructions,
        grantLog: nextLog(this.teams, member, entry),
      });
    });
    this.record(lead, next, changed, model && { from: ids(agent.model), to: model });
    this.note(lead, next, conversation, inv, {
      changed,
      previousName: member.name,
      models,
    });
    this.onChanged(next);
    a.changed?.();
    return {
      status: "updated",
      memberId: member.id,
      changed,
      effective: "next_turn",
    };
  }
  // Model changes name their ids only, never the owner's connection names.
  record(lead, member, changed, models) {
    try {
      this.audit?.append({
        action: "assistant.updated",
        resourceType: "assistant",
        resourceId: member.assistantId,
        source: "system",
        outcome: "success",
        details: {
          kind: "member-edit",
          edited: changed,
          ...(models ? { models } : {}),
          teamId: member.teamId,
          leadAssistantId: lead.id,
        },
      });
    } catch (error) {
      console.error("Member edit audit failed:", error?.message);
    }
  }
  // One settled row per chat, the member's and the lead's (actionNotes).
  note(lead, member, conversation, inv, { changed, previousName, models }) {
    const store = this.assistants.workflows?.store;
    if (!store) return;
    const at = Date.now();
    const payload = {
      action: "member_update",
      memberId: member.id,
      memberName: member.name,
      ...(previousName !== member.name ? { previousName } : {}),
      teamId: member.teamId,
      edited: changed,
      ...(models ? { model: models } : {}),
    };
    for (const [assistantId, conversationId] of [
      [member.assistantId, member.conversationId],
      [lead.id, conversation.id],
    ]) {
      if (!conversationId) continue;
      store.reserve({
        assistantId,
        conversationId,
        attemptId: inv.attemptId,
        origin: { kind: "member-grant" },
        key: `member-update:${inv.attemptId}:${inv.toolCallId}:${assistantId}`,
        state: "completed",
        payload,
        chatNotes: { result: { at, state: "completed" } },
        settled: true,
      });
    }
  }
}
