// SSH accesses as GrantPicker entries (web/components/grant-picker.js), shared by the
// session SSH dialog and the new-session dialog. Free of React so
// tests/unit/ssh-grant-entries.test.js can check it directly.

/**
 * One entry per access: the connection as `sub`, SFTP as a badge, an access the project
 * grants (`inherited`) locked with its note, a selected access noted as explicitly
 * assigned (as SshChoices shows it), and an
 * inherited access that is also explicitly assigned offers removing the assignment
 * when `onRemoveExplicit(id)` is given.
 */
export function sshGrantEntries(
  accesses,
  { selected = [], inherited = [], onRemoveExplicit, copy, projectCopy },
) {
  return accesses.map((access) => {
    const managed = inherited.includes(access.id);
    const explicit = selected.includes(access.id);
    const entry = {
      id: access.id,
      name: access.name,
      sub: `${access.username}@${access.host}:${access.port}`,
      badge: access.type === "sftp" ? copy.sftpBadge : undefined,
      locked: managed,
      notes: [
        ...(managed ? [projectCopy.projectManaged] : []),
        ...(explicit ? [projectCopy.explicitAssignment] : []),
      ],
    };
    if (managed && explicit && onRemoveExplicit)
      entry.action = {
        label: projectCopy.removeExplicit,
        onClick: () => onRemoveExplicit(access.id),
      };
    return entry;
  });
}
