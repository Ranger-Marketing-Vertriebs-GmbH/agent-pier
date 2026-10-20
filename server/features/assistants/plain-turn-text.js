// A restricted user's turn reaches the Gateway as plain text, never as an OpenClaw
// command or directive.
//
// OpenClaw 2026.10.3 forwards `sessions.send` to `chat.send` with the command
// authority of AgentPier's admin connection: a message starting with `/` runs as an
// owner's text-slash command (`/restart`, `/update`, `/model`, `/subagents`, ...), and
// inline directives such as `/model x` or `/think high` count anywhere after
// whitespace. `sessions.send` has no `suppressCommandInterpretation`. A word joiner
// (U+2060) before every `/` or `!` that starts the text or follows whitespace keeps
// OpenClaw's matchers (`startsWith("/")`, `(?<!\S)\/model`) from seeing a command,
// while the model reads the same text. The chat history removes it again.

const JOINER = "⁠";
const sigil = /(^|\s)([/!])/g;
const joined = /⁠(?=[/!])/g;

/** The text as a user's turn sends it: no command or directive OpenClaw parses. */
export function plainTurnText(text) {
  return typeof text === "string" ? text.replace(sigil, `$1${JOINER}$2`) : text;
}

/** A transcript text as the chat shows it: without the joiners `plainTurnText` added. */
export function shownTurnText(text) {
  return typeof text === "string" ? text.replace(joined, "") : text;
}
