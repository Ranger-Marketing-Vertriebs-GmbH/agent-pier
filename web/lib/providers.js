import { cliName, codingCliIds } from "../../server/features/clis/catalog.js";
import { commonCopy } from "./i18n/messages/common.js";
export const names = {
  ...Object.fromEntries(codingCliIds().map((id) => [id, cliName(id)])),
  shell: "Shell",
  gh: "GitHub CLI",
  nono: "nono",
  chromium: "Chrome for Testing",
  rea: "REA",
};
// The page a utility sends the user to once it is installed. A utility without an
// entry has nothing to configure in AgentPier, so it gets no follow-up action.
export const utilityPages = {
  gh: "connections/github",
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
