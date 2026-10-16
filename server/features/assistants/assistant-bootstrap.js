// Agents read English. The managed section follows the owner's instructions in
// AGENTS.md; AssistantConfig writes and verifies the combined text on every turn.
const quoted = (value) =>
  JSON.stringify(String(value).replace(/\s+/g, " ").trim().slice(0, 200));

/**
 * The AGENTS.md content of a managed agent: the owner's instructions plus
 * AgentPier's guidance. `display` names the connection and model as the owner
 * sees them, so the agent never answers with internal provider references.
 */
// Agents answer forwarded contacts and team members; personal addresses stay out.
const shareable = (value) =>
  typeof value === "string" && !/[^\s@]+@[^\s@]+/.test(value) ? value : undefined;

import { personalCapabilities } from "./native-capabilities.js";

// OpenClaw's own memory routine never reaches the workspace (skipBootstrap), so an
// agent with memory learns here that only a file write persists anything.
const memoryGuidance = (member) =>
  [
    "## Memory",
    "- This conversation is not your memory: it gets compacted and older turns are cut. Only what you write to a file survives.",
    "- Write durable facts, decisions and plans to `MEMORY.md` (curated, keep it tidy) and day-to-day notes to `memory/YYYY-MM-DD.md` with the write or edit tool.",
    "- Write as soon as the user shares something worth keeping, not later in the conversation.",
    "- Never say \"saved\", \"noted\" or \"I'll remember\" unless a write succeeded in this turn. If a write is refused or fails, say plainly that it was not saved.",
    ...(member
      ? [
          "- When your team lead asks or delegates something to you, memory is read-only in that turn: do not try to write it, and tell the lead it was not saved.",
        ]
      : []),
  ].join("\n");

export function assistantBootstrap(assistant, display = {}) {
  const model = shareable(display.model) || shareable(assistant.model?.modelId);
  const connection = shareable(display.connection);
  const identity = model
    ? `- You run on the model ${quoted(model)}${
        connection ? ` through the AgentPier connection ${quoted(connection)}` : ""
      }. When asked which model or provider you use, answer with these names. Never quote internal provider or model references such as identifiers that start with "ap-".`
    : null;
  const managed = [
    "## AgentPier",
    ...(identity ? [identity] : []),
    "- Internal identifiers (agent, session, provider or connection IDs) and operator or command-line instructions (for example `openclaw …` commands) are for AgentPier only. The user cannot run them: never suggest such commands or repeat such identifiers. When a tool reports an internal maintenance step, tell the user that the feature is temporarily unavailable instead.",
  ].join("\n");
  const sections = personalCapabilities(assistant).memory
    ? `${managed}\n\n${memoryGuidance(!!assistant.teamMemberId)}`
    : managed;
  const instructions = String(assistant.instructions || "").trimEnd();
  return instructions ? `${instructions}\n\n${sections}\n` : `${sections}\n`;
}
