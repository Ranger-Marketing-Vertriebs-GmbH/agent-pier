// agentpier_preview (agent-previews.js). The limits match the session MCP's
// preview_open (previews/preview-mcp.js); an open answers within
// index.js toolTimeouts.preview.
const text = (maxLength) => ({ type: "string", minLength: 1, maxLength });

export const previewDefinition = {
  preview: {
    description:
      "Give the owner a link to a web server you run on a local port, opened through AgentPier, so they can look at or test it on any of their devices. When you start a server for the owner to look at or test, call agentpier_preview (action open) with its port and give the owner the returned link instead of a localhost URL. Bind the server to 127.0.0.1 or localhost. Close it with action close when it is no longer needed. open takes port, an optional label naming the preview and an optional path (starting with /) of the page to open; opening a port again updates its label and path and returns the same link. close takes the preview's id or its port (exactly one), list shows this chat's previews. A preview belongs to this chat and ends 24 hours after its last use. Use it in the owner's own chat only (FORBIDDEN otherwise: do not retry). PREVIEW_NOT_LISTENING: start the server first. PREVIEW_DISABLED: the owner has to turn previews on in AgentPier's settings; tell them. PREVIEW_PORT_FORBIDDEN: that port cannot be shared; use another. PREVIEW_RANGE_FULL: close a preview you no longer need.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["open", "close", "list"] },
        port: { type: "integer", minimum: 1, maximum: 65535 },
        label: text(80),
        path: text(2048),
        id: text(80),
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
};
