// OpenClaw stores a sent turn without trailing whitespace (assistant-channel-contract.js).
const turnText = (text) => String(text).replace(/\r\n?/g, "\n").trimEnd();

/**
 * Whether the stored message `m` is the turn of `request`. A stored turn names its
 * request; older or unkeyed turns still match by text.
 */
export const sameTurn = (m, request) =>
  m.role === "user" &&
  (m.requestId
    ? m.requestId === request.id
    : turnText(m.text) === turnText(request.text));
