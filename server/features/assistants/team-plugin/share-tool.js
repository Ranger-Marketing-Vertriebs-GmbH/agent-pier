// agentpier_share_file (agent-shares.js). The limits match agent-share-source.js.
export const shareDefinition = {
  share_file: {
    description:
      "Hand the owner a file from your own workspace: it appears in this chat (images inline, other files as downloads) and, when this turn came from the owner's Telegram chat, in Telegram too. As a team member, your file also appears in your lead's chat. path: relative to your workspace (or absolute inside it); a regular file of at most 25 MB, not a symbolic or hard link. caption: optional short text shown with the file. Shared copies count against your attachments/ storage (512 MB or 1000 files); when it is full, delete files you no longer need from attachments/ and tell the owner. Share only what the owner's request needs, and never credentials or secrets unless the owner asked for exactly that file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 4096 },
        caption: { type: "string", maxLength: 1024 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
};
