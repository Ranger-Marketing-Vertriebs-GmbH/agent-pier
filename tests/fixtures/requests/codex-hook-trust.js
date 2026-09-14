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
