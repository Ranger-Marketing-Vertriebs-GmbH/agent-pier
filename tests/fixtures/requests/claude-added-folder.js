/**
 * Claude Code 2.1.326's startup dialog for a folder passed with --add-dir, as an owner
 * saw it for the chat attachment folder. `path` is printed as given: pass it with
 * "\n " where the terminal wraps it. `held` shows the hint Claude prints instead of the
 * footer after refusing a confirmation, `repository` the line for a folder in a
 * repository, and `short` the layout of a window too short for blank lines.
 */
export const addedFolderScreen = (
  path,
  { selected = "exit", held = false, repository, short = false } = {},
) => {
  const gap = short ? "" : "\n";
  const blocks = [
    ` ${path}`,
    ...(repository
      ? [
          ` This directory is part of the repository at ${repository}. Trusting it\n trusts that whole repository, including its other worktrees and subdirectories.`,
        ]
      : []),
    ` This session hasn't worked here before. Is this a\n directory you created or one you trust?`,
    ` Claude Code'll be able to read, edit, and execute\n files here. Its skills, commands, and agents load\n and can run commands, and so can the git settings\n of its repository. Your answer holds for this\n session. Starting Claude Code in this directory\n and trusting it there lasts, and covers its whole\n repository or everything below it.`,
    ` Security guide`,
    ` ${selected === "exit" ? "❯" : " "} No, exit\n ${selected === "add" ? "❯" : " "} Yes, add it`,
    held
      ? ` Esc to exit · To add it, press ↓ to Yes, then\n Enter (your text is kept)`
      : ` Enter to confirm · Esc to cancel`,
  ];
  return `\n${"─".repeat(50)}\n Adding a new directory:\n${gap}${blocks.join(`\n${gap}`)}\n`;
};
