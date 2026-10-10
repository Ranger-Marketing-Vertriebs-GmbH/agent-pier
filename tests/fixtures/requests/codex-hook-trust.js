export const hookScreen = (selected = 1, error = "") => `
  Hooks need review
  2 hooks are new or changed.
  Hooks can run outside the sandbox after you trust them.
  ${error}

${selected === 1 ? "›" : " "} 1. Review hooks
${selected === 2 ? "›" : " "} 2. Trust all and continue
${selected === 3 ? "›" : " "} 3. Continue without trusting (hooks won't run)

  Press enter to confirm or esc to go back
`;
export const hookList = {
  data: [
    {
      cwd: "/fixture",
      hooks: [
        {
          key: "one",
          currentHash: "hash-one",
          trustStatus: "untrusted",
          eventName: "SessionStart",
          command: "echo fixture",
        },
        {
          key: "two",
          currentHash: "hash-two",
          trustStatus: "modified",
          eventName: "UserPromptSubmit",
          command: "echo fixture",
        },
      ],
    },
  ],
};
// Captured from Codex v0.160.1 (tmux capture-pane -e, 140 columns): the footer
// changed to "enter confirm · esc skip" and the selected row is padded reverse video.
const v160Row = (selected, n, label) =>
  selected === n
    ? `\u001b[1;7m› ${n}. ${label}${" ".repeat(120 - label.length)}\u001b[0m`
    : `  ${n}. ${label}`;
export const hookScreenV160 = (selected = 1) =>
  "\n  \u001b[1mHooks need review\u001b[0m\n" +
  "  \u001b[38;5;3m7 hooks are new or changed.\u001b[39m\n" +
  "  \u001b[2mHooks can run outside the sandbox after you trust them.\u001b[0m\n\n\n" +
  [
    v160Row(selected, 1, "Review hooks"),
    v160Row(selected, 2, "Trust all and continue"),
    v160Row(selected, 3, "Continue without trusting (hooks won't run)"),
  ].join("\n") +
  "\n\n  \u001b[1menter\u001b[0;2m confirm · \u001b[0;1mesc\u001b[0;2m skip\n\u001b[0m\n";
