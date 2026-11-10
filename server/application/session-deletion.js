/** Delete a stopped session and its data through the same path for HTTP and agents. */
export async function deleteSession(services, session) {
  const id = session.id;
  // Capture attachments before removal; a running session rejected by remove()
  // keeps all its data. The manager also retires artifacts and closes previews.
  const directory = session.attachments?.directory;
  await services.sessions.remove(id);
  services.sessionMcp?.discard(id);
  services.sshSessions?.discard(id);
  services.sessionSecrets?.discard(id);
  await services.sshIntegration?.discard(id);
  await services.chatDelivery.discard(id);
  await services.chatAttachments.discard(id, directory);
  await services.requests.discard(id);
  await services.memoryIntegration.discard(id);
  services.activity.remove(id);
  services.chat.remove(id);
  services.chatImages?.forgetSession(id);
  services.chatSync?.discard(id);
  await services.bindings.discard(id);
  await services.github.discard(id);
  services.models.remove(id);
  services.live?.invalidate("state");
}
