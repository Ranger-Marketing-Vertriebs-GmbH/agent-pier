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
  const instructions = String(assistant.instructions || "").trimEnd();
  return instructions ? `${instructions}\n\n${managed}\n` : `${managed}\n`;
}
