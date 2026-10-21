// agentpier_share_file (agent-shares.js). The limits match agent-share-source.js.
export const shareDefinition = {
  share_file: {
    description:
      "Hand the person you are talking with a file from your own workspace: it appears in this chat (images inline, other files as downloads) and, when this turn came from a Telegram chat, in Telegram too. As a team member, your file also appears in your lead's chat. path: relative to your workspace (or absolute inside it); a regular file of at most 25 MB, not a symbolic or hard link. caption: optional short text shown with the file. projectId: share from a project folder granted to you instead (use agentpier_workspace catalog for the id; reading it is enough), with path relative to that folder. AgentPier keeps its own copy for 90 days (the oldest go first when your share storage is full); you cannot change or delete it, and it can be deleted in the chat. Share only what the request needs, and never credentials or secrets unless exactly that file was asked for.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 4096 },
        caption: { type: "string", maxLength: 1024 },
        projectId: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
};
