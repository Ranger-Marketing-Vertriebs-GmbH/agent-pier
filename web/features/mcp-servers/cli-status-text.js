import { mcpCliCopy as copy } from "../../lib/i18n/messages/mcp-cli.js";
import { names } from "../../lib/providers.js";

/** A CLI binding's status as text: "the name is already used by another entry …". */
export const statusText = (state) =>
  state.status === "error"
    ? copy.errorWithReason(copy.reasons[state.reason] || copy.reasons.failed)
    : copy.statuses[state.status] || copy.statuses.pending;

/** "Claude Code: …" for a managed tool's binding error (`{ cli, status, reason }`). */
export const bindingLine = (binding) =>
  binding ? copy.statusLine(names[binding.cli] || binding.cli, statusText(binding)) : "";
