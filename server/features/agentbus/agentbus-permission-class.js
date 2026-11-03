import { cliDefinition, isCodingCli } from "../clis/catalog.js";

// Claude Code delivers a cross-session message automatically only when the sender's
// attested permission class matches its own; otherwise it holds the message for
// manual approval. AgentPier attests the class the sending session was launched
// with. Anything not known to run without permission prompts counts as prompting.
export function permissionClass(session) {
  if (!session || typeof session !== "object") return "prompting";
  // Headless pipeline turns always run autonomously (native-command.js).
  if (session.pipeline?.headless === true) return "bypass";
  const mode = session.launchMode;
  const args = Array.isArray(session.permissionArgs) ? session.permissionArgs : [];
  const tool = session.tool;
  const bypass =
    isCodingCli(tool) &&
    (cliDefinition(tool).unattendedModes.includes(mode) ||
      args.some((arg) => cliDefinition(tool).unattendedArgs.includes(arg)));
  return bypass ? "bypass" : "prompting";
}
