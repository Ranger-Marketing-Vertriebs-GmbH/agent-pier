/**
 * The agent routes sorted by what they expose. Content routes return or change what a
 * user wrote or her agent produced for her (chats, attachments, memory, reminders,
 * approvals, the browser, the channel that delivers into her chat); the owner's privacy guard (Task 20) resolves the route's
 * `:id` to its conversation or agent and refuses what he may not read. Metadata routes
 * show or change settings only. A route that is not clearly metadata counts as content.
 * `tests/integration/owner-content-classification.test.js` fails on a new agent route
 * until it is classified here.
 */

/** What a content route's first parameter names, so the guard can find its owner. */
export const contentKinds = [
  "conversation",
  "attempt",
  "attachment",
  "agent",
  "agentChats",
  "action",
  "channel",
];

export const ownerContentRoutes = {
  // Conversations: messages, the queued message, uploads and shared files.
  "POST /api/assistants/:id/conversations": "agent",
  // The chat list names the chats and their titles; New chat starts one.
  "GET /api/assistants/:id/chats": "agent",
  "POST /api/assistants/:id/chats": "agent",
  // Renaming, archiving, restoring and deleting change a chat: his own only.
  "PATCH /api/assistant-conversations/:id": "conversation",
  "POST /api/assistant-conversations/:id/archive": "conversation",
  "POST /api/assistant-conversations/:id/restore": "conversation",
  "DELETE /api/assistant-conversations/:id": "conversation",
  // Summarising a long chat or hiding its hint acts on it: his own only.
  "POST /api/assistant-conversations/:id/compact": "conversation",
  "POST /api/assistant-conversations/:id/long-chat-dismissal": "conversation",
  "POST /api/assistant-conversations/:id/goal/stop": "conversation",
  "GET /api/assistant-conversations/:id/messages": "conversation",
  "POST /api/assistant-conversations/:id/messages": "conversation",
  "POST /api/assistant-conversations/:id/queued": "conversation",
  "DELETE /api/assistant-conversations/:id/queued": "conversation",
  "POST /api/assistant-conversations/:id/attachments": "conversation",
  "GET /api/assistant-conversations/:id/attachments/:file": "conversation",
  "DELETE /api/assistant-conversations/:id/attachments/:file": "conversation",
  "DELETE /api/assistant-conversations/:id/shared-files/:file": "conversation",
  "POST /api/assistant-conversations/:id/video-uploads": "conversation",
  "PUT /api/assistant-conversations/:id/video-uploads/:upload": "conversation",
  "DELETE /api/assistant-conversations/:id/video-uploads/:upload": "conversation",
  "GET /api/assistant-attachments/:file": "attachment",
  // Clearing the folder removes the files of every chat on the agent, users' included.
  "DELETE /api/assistants/:id/attachments": "agentChats",
  // Turns in flight.
  "POST /api/assistant-attempts/:id/cancel": "attempt",
  "POST /api/assistant-attempts/:id/recover": "attempt",
  // Memory and the browser the agent uses for its users.
  "GET /api/assistants/:id/memory": "agent",
  "PUT /api/assistants/:id/memory": "agent",
  "GET /api/assistants/:id/memory/files": "agent",
  "GET /api/assistants/:id/memory/search": "agent",
  "GET /api/assistants/:id/browser": "agent",
  "POST /api/assistants/:id/browser/reset": "agent",
  // Reminders and routines carry the texts a user asked for.
  "GET /api/assistants/:id/reminders": "agent",
  "POST /api/assistants/:id/reminders": "agent",
  "PATCH /api/assistants/:id/reminders/:bindingId": "agent",
  "DELETE /api/assistants/:id/reminders/:bindingId": "agent",
  "POST /api/assistants/:id/reminders/:bindingId/review": "agent",
  "GET /api/assistants/:id/reminders/:bindingId/runs": "agent",
  "GET /api/assistants/:id/routines": "agent",
  "POST /api/assistants/:id/routines": "agent",
  "PATCH /api/assistants/:id/routines/:routineId": "agent",
  "DELETE /api/assistants/:id/routines/:routineId": "agent",
  "POST /api/assistants/:id/routines/:routineId/events": "agent",
  "POST /api/assistants/:id/routines/:routineId/review": "agent",
  "GET /api/assistants/:id/routines/:routineId/runs": "agent",
  // Approvals show the tool calls a turn asked for, and their results.
  "GET /api/assistants/:id/actions": "agent",
  "POST /api/assistants/:id/actions/:actionId/cancel": "agent",
  "GET /api/assistants/:id/actions/:actionId/artifacts": "agent",
  "POST /api/assistant-actions/:id/decision": "action",
  // A channel delivers into the agent's main chat: re-pairing it hands its chat to
  // whoever redeems the code, and changing or removing it reroutes her reminders.
  "PATCH /api/assistant-channels/:id": "channel",
  "POST /api/assistant-channels/:id/pair": "channel",
  "DELETE /api/assistant-channels/:id": "channel",
  // Re-delivering a channel's inbound message or notification touches a chat.
  "POST /api/assistant-channels/:id/inputs/:inputId/:action": "channel",
  "POST /api/assistant-channels/:id/notifications/:notificationId/:action": "channel",
};

export const ownerMetadataRoutes = new Set([
  "GET /api/assistants/:id/access",
  "PUT /api/assistants/:id/access",
  "PUT /api/assistants/:id/team-policy",
  "PUT /api/assistants/:id/work",
  "GET /api/assistants/:id/shell-allowlist",
  "DELETE /api/assistants/:id/shell-allowlist/:entry",
  "GET /api/assistants/:id/skills",
  "GET /api/assistants/:id/attachment-usage",
  "GET /api/assistant-conversations/:id/attachment-policy",
]);

/** Paths of routes that belong to one agent or one of its chats, turns or files. */
export const agentScoped = [
  /^\/api\/assistant-(?:conversations|attempts|attachments|actions|channels)\//,
  /^\/api\/assistants\/[^/]+\//,
];
