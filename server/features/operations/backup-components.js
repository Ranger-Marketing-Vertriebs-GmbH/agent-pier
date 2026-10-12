import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

/**
 * Backup errors name the component they come from: a CLI profile by its name and
 * CLI, everything else by its area. `kind` is "changed", "unreadable" or "linked".
 */
export const toolNames = Object.freeze({
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
});
const profileKinds = {
  changed: "profileChanged",
  unreadable: "profileUnreadable",
  // Profiles skip links instead of failing; a link found later reads as a change.
  linked: "profileChanged",
};
export const profileComponent = (account) => ({
  profile: { name: account.name, tool: toolNames[account.tool] || account.tool },
});
export const areaComponent = (area) => ({ area });

/** The problem for `kind` in the component of `entry` (`{ component }`). */
export function componentProblem(kind, entry) {
  const component = entry?.component;
  const messages = serverMessages.backups;
  if (component?.profile)
    return problem(
      messages[profileKinds[kind]](component.profile.name, component.profile.tool),
      409,
    );
  const byArea = messages[kind];
  return problem(byArea[component?.area] || byArea.applicationData, 409);
}

/** Bytes as a short, language-neutral size such as "1.5 GiB". */
export function formatBytes(bytes) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit ? value.toFixed(1) : value} ${units[unit]}`;
}
