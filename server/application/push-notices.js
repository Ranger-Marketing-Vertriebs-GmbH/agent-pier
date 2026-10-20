// What the push emitters tell the notification service about a session, a run or an
// agent: identifiers, the names a device may see at the "with label" level and the
// text a device may see at the "with preview" level. The notification service decides
// per device what is sent and drops anything that looks like a command, path, URL or
// secret (server/features/notifications/push-content.js).

const folder = (cwd) =>
  typeof cwd === "string" ? cwd.split("/").filter(Boolean).at(-1) || "" : "";

/** A session's name, CLI and project folder (the folder's name, never its path). */
export function sessionNotice(session) {
  return {
    sessionId: session.id,
    ...(session.name ? { label: session.name } : {}),
    ...(session.tool ? { tool: session.tool } : {}),
    ...(folder(session.cwd) ? { project: folder(session.cwd) } : {}),
  };
}

/** A native question or approval, at its inbox address; a question previews itself. */
export function requestNotice(event, session, entry) {
  const question = event.kind === "question";
  const first = entry?.questions?.[0];
  return {
    ...(session ? sessionNotice(session) : {}),
    sessionId: event.sessionId,
    inbox: { type: question ? "question" : "approval", id: event.resourceId },
    ...(question && (first?.prompt || first?.header)
      ? { preview: first.prompt || first.header }
      : {}),
  };
}

/** A run's pipeline, current stage and project; a gate opens its inbox item. */
export function runNotice(run, gate) {
  const node = run.nodes?.find((n) => n.id === run.currentNodeId);
  const stage = node?.profileSnapshot?.name || node?.label || node?.kind || "";
  const project = folder(run.workingDir || run.cwd);
  return {
    runId: run.id,
    ...(run.pipelineName ? { label: run.pipelineName } : {}),
    ...(stage ? { stage } : {}),
    ...(project ? { project } : {}),
    ...(gate ? { inbox: { type: "gate", id: run.id } } : {}),
  };
}

/** The start of a session's latest reply, read from its chat (best effort). */
export async function replyPreview(chat, session) {
  if (!chat?.read) return null;
  const content = await chat.read(session.id);
  const reply = content?.messages?.findLast?.(
    (message) =>
      message.role === "assistant" &&
      message.status !== "failed" &&
      typeof message.text === "string" &&
      message.text.trim(),
  );
  return reply ? reply.text.slice(0, 4000) : null;
}

/** An agent's name, and the agent's chat a notice opens. */
export function agentNotice(assistants, assistantId, conversationId = null) {
  let agent = null,
    conversations = [];
  // A notice still goes out without the name or the chat.
  try {
    agent = assistants?.store?.getAssistant?.(assistantId) || null;
  } catch {
    agent = null;
  }
  try {
    conversations = assistants?.store?.listConversations?.() || [];
  } catch {
    conversations = [];
  }
  const chat =
    conversations.find(
      (c) => c.id === conversationId && c.assistantId === assistantId && !c.archivedAt,
    ) ||
    // Without its own chat a notice links the owner's chat, never a user's.
    conversations.find(
      (c) => c.assistantId === assistantId && !c.archivedAt && !c.userId,
    );
  return {
    assistantId,
    ...(chat ? { conversationId: chat.id } : {}),
    ...(agent?.name ? { label: agent.name } : {}),
  };
}
