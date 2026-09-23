import { commonCopy } from "./i18n/messages/common.js";
export const names = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  shell: "Shell",
  gh: "GitHub CLI",
  nono: "nono",
};
// The page a utility sends the user to once it is installed. A utility without an
// entry has nothing to configure in AgentPier, so it gets no follow-up action.
export const utilityPages = {
  gh: "repositories",
};
export const statusLabels = {
  get running() {
    return commonCopy.active;
  },
  get exited() {
    return commonCopy.ended;
  },
  get stopped() {
    return commonCopy.stopped;
  },
};
