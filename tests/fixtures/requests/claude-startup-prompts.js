// Synthetic frames modeled on Claude Code 2.1.270 onboarding screens.
const rule = (width) => "─".repeat(width);
const link = (label) =>
  `]8;id=zaxmda;https://code.claude.com/docs/en/security\\${label}]8;;\\`;
export const themeLabels = [
  "Auto (match terminal)",
  "Dark mode",
  "Light mode",
  "Dark mode (colorblind-friendly)",
  "Light mode (colorblind-friendly)",
  "Dark mode (ANSI colors only)",
  "Light mode (ANSI colors only)",
];
export const themeScreen = (selected = 2, { narrow = false } = {}) => `
 [1mLet's get started.[22m
${
  narrow
    ? " Choose the text style that looks best with your\n terminal"
    : " Choose the text style that looks best with your terminal"
}
 To change this later, run /theme
${themeLabels
  .map(
    (label, index) =>
      ` ${index + 1 === selected ? "[36m❯" : " "} ${index + 1}. ${label}${
        index === 1 ? " ✔" : ""
      }[39m`,
  )
  .join("\n")}
 ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  1  function greet() {
  2 -  console.log("Hello, World!");
  2 +  console.log("Hello, Claude!");
  3  }
 ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  Syntax theme: Monokai Extended (ctrl+t to disable)
`;
export const apiKeyScreen = (selected = "no", { narrow = false } = {}) => `
Welcome to Claude Code v2.1.270
${rule(narrow ? 50 : 120)}
  Detected a custom API key in your environment
${
  narrow
    ? "  ANTHROPIC_API_KEY:\n  sk-ant-...tic-probe-key-000000"
    : "  ANTHROPIC_API_KEY: sk-ant-...tic-probe-key-000000"
}

  Do you want to use this API key?

  ${selected === "yes" ? "❯" : " "} Yes
  ${selected === "no" ? "❯" : " "} No (recommended)

  Enter to confirm · Esc to cancel
`;
export const securityNotesScreen = () => `
Welcome to Claude Code v2.1.270

 Security notes:

 1. Claude can make mistakes.
    You're responsible for Claude's actions and should always
    review them, especially when running code.

 2. Due to prompt injection risks, only use it with code you trust
    Learn more: ${link("https://code.claude.com/docs/en/security")}

 Press Enter to continue…
`;
export const loginScreen = () => `
Welcome to Claude Code v2.1.270

 Claude Code can be used with your Claude subscription or billed based on API usage through your Console account.

 Select login method:

 ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise
   2. Anthropic Console account · API usage billing
   3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI
`;
export const oauthScreen = () => `
Welcome to Claude Code v2.1.270

 Browser didn't open? Use the url below to sign in (c to copy)

https://claude.com/cai/oauth/authorize?code=true&client_id=synthetic

 Hold Shift (Option in iTerm2, Fn in Terminal.app) while selecting to use your terminal's native copy

 Paste code here if prompted >
`;
export const unknownMenuScreen = () => `
Welcome to Claude Code v2.1.270

 Would you like to enable the synthetic future feature?

 ❯ Yes, enable it
   Not now

 Enter to confirm · Esc to cancel
`;
export const composerScreen = () => `
 ▐▛███▛█   Claude Code v2.1.270
▝▜██████▀  Sonnet 4.6 · API Usage Billing
  ▝▝ ▝▝    ~/project

${rule(120)}
❯
${rule(120)}
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`;
export const permissionScreen = () => `
⏺ Bash(rm -rf build)

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for rm commands in ~/project
   3. No

 Esc to cancel
`;
/** Onboarding phrases quoted inside a running transcript must not block chat. */
export const transcriptLookalikeScreen = () => `
⏺ Read(docs/direct-chat-tui-validation.md)
  ⎿  Security notes: the CLI prints "Press Enter to continue" after
     "Select login method:" and "Detected a custom API key in your environment".
     "Do you want to use this API key?" · "Paste code here if prompted" ·
     Choose the text style that looks best with your terminal · Enter to confirm

${"─".repeat(120)}
❯ 
${"─".repeat(120)}
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`;
