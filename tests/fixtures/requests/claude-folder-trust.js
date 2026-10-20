export const folderScreen = (cwd = "/fixture/project", selected = "exit") => `
${"─".repeat(50)}
 Accessing workspace:

 ${cwd}

 Quick safety check: Is this a project you
 created or one you trust? (Like your own code, a
 well-known open source project, or work from
 your team). If not, take a moment to review
 what's in this folder first.

 Claude Code'll be able to read, edit, and
 execute files here.

 Security guide

 ${selected === "exit" ? "❯" : " "} No, exit
 ${selected === "trust" ? "❯" : " "} Yes, I trust this folder

 Enter to confirm · Esc to cancel
`;
/**
 * Synthetic frame of Claude Code 2.1.304 with settings warnings printed above the
 * folder-trust dialog, as an owner's permission rules can cause. The rules are made up.
 */
export const folderScreenWithWarnings = (cwd, selected = "exit") => `
 ⚠ Found 2 invalid settings in ~/.claude/settings.json · /doctor for details

   permissions.allow[3]: "Bash(npm run *:*)" uses ":*" after a wildcard; use
   "Bash(npm run *)" instead. The rule was skipped.
   permissions.deny[0]: "Read(./secrets/**" is missing a closing parenthesis.
   The rule was skipped.

 ${"─".repeat(40)}
 Settings warnings do not stop Claude Code.
${folderScreen(cwd, selected)}`;
