/** The hosts a launch may offer: a shell has no SFTP tools, so no SFTP hosts. */
export function launchAccesses(accesses, sftp) {
  return sftp ? accesses : accesses.filter(({ type }) => type !== "sftp");
}

/**
 * `selected` without the hosts the launch cannot take (SFTP hosts once the tool is a
 * shell), or `selected` itself when nothing has to go.
 */
export function launchSelection(selected, accesses, sftp) {
  if (sftp) return selected;
  const sftpIds = new Set(
    accesses.filter(({ type }) => type === "sftp").map(({ id }) => id),
  );
  const kept = selected.filter((id) => !sftpIds.has(id));
  return kept.length === selected.length ? selected : kept;
}
