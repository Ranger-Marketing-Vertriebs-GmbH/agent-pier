// A failed tool call in a nono-sandboxed session whose output reads like an operating
// system denial: EPERM/EACCES (macOS Seatbelt, Linux Landlock), "Operation not
// permitted" or a Seatbelt `deny(1)` line. Any tool counts, MCP servers included,
// because the sandbox confines every subprocess of the CLI. A hint, not a verdict:
// the same errors can have other causes, so the chat names it as likely.
const denial =
  /\bE(?:PERM|ACCES)\b|operation not permitted|\bpermission denied\b|\bdeny\(\d+\)|\bsandbox(?:-exec)?\b[^\n]{0,80}\bden(?:y|ied)\b/i;
// Errors sit at the start or end of an output; a long one is not scanned in full.
const edge = 16384;

const scanned = (text) =>
  text.length <= edge * 2 ? text : `${text.slice(0, edge)}\n${text.slice(-edge)}`;

/** True when this tool row failed in a sandboxed session with a denial in its output. */
export function sandboxDenied(message, sandboxProfile) {
  if (!sandboxProfile || message?.role !== "tool" || message.subagent) return false;
  if (message.status !== "failed" || typeof message.text !== "string") return false;
  return denial.test(scanned(message.text));
}
