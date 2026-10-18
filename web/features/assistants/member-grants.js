import { memberGrantCopy as copy } from "../../lib/i18n/messages/assistant-member-grants.js";
import { assistantShellCopy as shellCopy } from "../../lib/i18n/messages/assistant-shell.js";

// The order grants are named in (server member-grants.js grantedKeys).
const keys = [
  "memory",
  "reminders",
  "webSearch",
  "webFetch",
  "browser",
  "documents",
  "createImages",
  "skills",
  "shell",
  "ssh",
  "projects",
  "github",
];

/** One label per grant; `servers` is the number of granted MCP servers. */
export function grantLabels(grants = {}, servers = 0) {
  return [
    ...keys
      .filter((key) => grants[key])
      .map((key) =>
        key === "shell"
          ? copy.labels.shell(shellCopy.levels[grants.shell] || grants.shell)
          : key === "skills"
            ? grants.skills === "all"
              ? copy.labels.allSkills
              : copy.labels.skills(grants.skills.length)
            : key === "projects"
              ? copy.labels.projects(Object.keys(grants.projects).length)
              : key === "github"
                ? copy.labels.github(copy.githubLevels[grants.github] || grants.github)
                : copy.labels[key],
      ),
    ...(servers ? [copy.labels.mcpServers(servers)] : []),
  ];
}

/** Labels for a list of granted keys (a note or log entry), with the shell level if known. */
export const keyLabels = (granted = [], servers = 0, shell = null) =>
  [
    ...granted.map((key) =>
      key === "skills"
        ? copy.labels.someSkills
        : key === "projects"
          ? copy.labels.someProjects
          : key === "github"
            ? copy.labels.someGithub
            : key === "shell"
              ? shell
                ? copy.labels.shell(shellCopy.levels[shell] || shell)
                : copy.labels.anyShell
              : copy.labels[key],
    ),
    ...(servers ? [copy.labels.mcpServers(servers)] : []),
  ].join(", ");

export const holdsShellSsh = (grants = {}) => !!(grants.shell || grants.ssh);

/** A member's folder levels as it uses them now: "1 read and write, 2 read". */
export function folderCounts(projects = {}) {
  const levels = Object.values(projects || {});
  const parts = ["write", "read"].flatMap((level) => {
    const count = levels.filter((value) => value === level).length;
    return count ? [copy.folderCounts[level](count)] : [];
  });
  return parts.length ? parts.join(", ") : copy.folderCounts.none;
}

/** The grants line of a member: "Gets: …" or "No tools". */
export const grantsLine = (grants, servers) => {
  const labels = grantLabels(grants, servers);
  return labels.length ? copy.gets(labels.join(", ")) : copy.none;
};

/** The changed fields of a lead's member edit, as words ("name, role"). */
export const fieldLabels = (fields = []) =>
  fields.map((key) => copy.fields[key] || key).join(", ");

/** One change in a member's grant log, dated as the viewer reads dates. */
export function logText(entry) {
  const date = new Date(entry.at).toLocaleString();
  if (entry.promoted) return copy.log.promoted(date);
  if (entry.edited) return copy.log.edited(date, fieldLabels(entry.edited));
  const labels = keyLabels(entry.revoked || entry.granted, entry.mcpServers);
  if (entry.revoked)
    return entry.by === "owner"
      ? copy.log.ownerRevoked(date, labels)
      : copy.log.revoked(date, labels);
  return entry.by === "owner"
    ? copy.log.owner(date, labels)
    : copy.log.lead(date, labels);
}

/** The note shape (server grantNotes) of a stored grant action, for the history. */
export const grantNote = (a) => {
  const p = a.payload;
  return p.approval
    ? {
        by: "owner",
        memberName: p.memberName,
        granted: keys.filter((key) => p.grants?.[key]),
        shell: p.grants?.shell || null,
        state: a.state,
      }
    : {
        by: p.by,
        memberName: p.memberName,
        granted: p.granted,
        revoked: p.revoked,
        mcpServers: p.mcpServers,
        state: a.state,
      };
};
