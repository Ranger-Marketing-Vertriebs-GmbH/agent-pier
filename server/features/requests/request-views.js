// What a request list shows of a broker entry: never the native socket, the
// occurrence key, the account, the launch identity or who claimed it.

/** An entry as the owner's inbox lists it (RequestBroker#listAll). */
export function inboxEntry({
  socket: _socket,
  key: _key,
  accountId: _account,
  launchIdentity: _launch,
  local: _local,
  interaction: _interaction,
  nativeOutcome: _outcome,
  claimedBy: _claimed,
  ...entry
}) {
  return entry;
}

/**
 * An entry as its session's request list shows it at server time `now`. Another
 * tab's interaction carries its moment in whole seconds (`at`, server clock) beside
 * its age then: a pushed list carries `sampledAt` (live-topics.js), from which a
 * client measures the age, so an unchanged list needs no new frame and a late copy
 * of it is not too young.
 */
export function sessionEntry(
  {
    socket: _socket,
    key: _key,
    accountId: _account,
    launchIdentity: _launch,
    local: _local,
    interaction,
    claimedBy: _claimed,
    ...entry
  },
  now,
) {
  if (!interaction) return entry;
  const at = Math.round(interaction.at / 1000) * 1000;
  return {
    ...entry,
    interaction: { client: interaction.client, at, age: now - interaction.at },
  };
}
