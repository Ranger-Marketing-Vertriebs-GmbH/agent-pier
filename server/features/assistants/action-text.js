// Shared by the action notices (assistant-action-notifications.js, agent-ssh-notifications.js).

// Model-chosen text shown verbatim: inside a code fence the Markdown renderer
// escapes everything, and a line that would close the fence is broken up.
export const fenced = (text) =>
  "```\n" + text.replace(/^(\s*)(```|~~~)/gm, "$1​$2") + "\n```";

export const actionPath = (action) =>
  action.teamId
    ? `/agents/${encodeURIComponent(action.assistantId)}/teams/${encodeURIComponent(action.teamId)}`
    : `/agents/${encodeURIComponent(action.assistantId)}/chats/${encodeURIComponent(action.conversationId)}`;
