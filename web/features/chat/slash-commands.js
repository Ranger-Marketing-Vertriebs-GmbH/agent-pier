// Built-in command names from the providers' command references. Availability can
// depend on CLI version, account and feature flags; this is completion, not an allowlist.
// https://developers.openai.com/codex/cli/slash-commands
// https://code.claude.com/docs/en/commands
// https://opencode.ai/docs/tui/
const catalogs = {
  codex:
    "agent subagents apps plugins hooks clear rename archive delete compact copy diff exit quit experimental approve memories skills import feedback init logout mcp mention model fast personality plan permissions new resume fork review status usage statusline title theme debug-config goal ide keymap vim ps stop app side btw raw pets pet",
  claude:
    "add-dir advisor agents artifact-capabilities artifact-diagramming artifacts auto-mode-setup autocompact autofix-pr background bg batch branch btw bug chrome clear code-review color compact config settings context copy cost dataviz debug deep-research design design-login design-sync desktop app diff doctor checkup effort exit quit export fast feedback fewer-permission-prompts focus fork goal help hooks ide import init insights install-github-app keybindings login logout loop mcp memory model permissions plan plugin pr-comments privacy release-notes reload-plugins remote-control rename resume review rewind sandbox security-review skills stats status statusline tasks terminal-setup theme todos upgrade usage vim voice",
  opencode:
    "connect compact summarize details editor exit quit q export help init models new clear redo sessions resume continue share themes thinking undo unshare",
};
export function builtinSlashCommands(tool) {
  return (catalogs[tool] || "")
    .split(" ")
    .filter(Boolean)
    .sort()
    .map((name) => ({ name }));
}
/**
 * Built-ins plus the commands the server discovered for the session (custom commands,
 * skills, plugin commands, prompts). A discovered command with a built-in's name
 * replaces it, because it carries a description.
 */
export function mergeSlashCommands(builtins, discovered) {
  const merged = new Map(
    builtins.map((command) => [command.name.toLowerCase(), command]),
  );
  for (const command of Array.isArray(discovered) ? discovered : [])
    if (typeof command?.name === "string" && command.name)
      merged.set(command.name.toLowerCase(), command);
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}
/**
 * Commands for a draft that is just a slash and a command name. A name that starts
 * with the typed text comes first, then one whose last part does (`/brain` finds
 * `superpowers:brainstorming`), then one that contains it.
 */
export function slashMatches(commands, text) {
  if (!/^\/[a-z0-9_.:/-]*$/i.test(text)) return [];
  const query = text.slice(1).toLowerCase();
  const rank = ({ name }) => {
    const value = name.toLowerCase();
    if (value.startsWith(query)) return 0;
    if (!query) return -1;
    if (value.split(/[:/]/).at(-1).startsWith(query)) return 1;
    return value.includes(query) ? 2 : -1;
  };
  return commands
    .map((command, index) => ({ command, index, rank: rank(command) }))
    .filter((item) => item.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.command);
}
