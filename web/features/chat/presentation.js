import { chatMessageCopy as copy } from "../../lib/i18n/messages/chat.js";
import { cliDefinition, codingCliIds } from "../../../server/features/clis/catalog.js";
export const providerNames = Object.fromEntries(
  codingCliIds().map((id) => [id, cliDefinition(id).shortName]),
);

// The server names rows the CLI leaves unnamed with these fixed English identifiers;
// a CLI's own tool names (Bash, Read, MCP tools) stay as the CLI wrote them.
const serverToolNames = {
  Command: "command",
  "File change": "fileChange",
  Tool: "tool",
  "View image": "viewImage",
  "Web search": "webSearch",
};

/** The label of a tool row in the owner's language. */
export function toolDisplayName(toolName) {
  if (!toolName) return copy.chatToolLabel;
  const key = Object.hasOwn(serverToolNames, toolName) ? serverToolNames[toolName] : null;
  return key ? copy.toolNames[key] : toolName;
}

/** The label of a shell-output stream (output, stdout, stderr) in the owner's language. */
export function shellStreamLabel(label) {
  return Object.hasOwn(copy.shellStreams, label) ? copy.shellStreams[label] : label;
}
