import { createContext, useContext } from "react";

const id = (value) => encodeURIComponent(value);

/**
 * Where an agent chat's files and dictation live: the owner's routes, or a restricted
 * user's /api/me routes (her app provides `userAgentPaths`). Her app has no chunked
 * video upload: a video goes up as one file, within the attachment limit.
 */
export const ownerAgentPaths = Object.freeze({
  conversation: (conversationId) => `/assistant-conversations/${id(conversationId)}`,
  attachment: (fileId) => `/assistant-attachments/${id(fileId)}`,
  dictation: "/dictation",
  videoUploads: true,
});

export const userAgentPaths = Object.freeze({
  conversation: (conversationId) => `/me/conversations/${id(conversationId)}`,
  attachment: (fileId) => `/me/attachments/${id(fileId)}`,
  dictation: "/me/dictation",
  videoUploads: false,
});

export const AgentPathsContext = createContext(ownerAgentPaths);

export const useAgentPaths = () => useContext(AgentPathsContext);
