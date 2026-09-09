import { commonCopy } from "./i18n/messages/common.js";
export const names = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  shell: "Shell",
  gh: "GitHub CLI",
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
