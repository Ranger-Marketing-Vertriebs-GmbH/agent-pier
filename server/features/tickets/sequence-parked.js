// A parked head ticket that has a pull request: its queue waits for the owner, but a
// merge still finishes it. Whoever merges the PR (the owner on GitHub, say, because
// AgentPier could not) has done what the ticket waited for, so the queue moves on
// without a Retry or Mark done. Nothing else is done for a parked ticket: no fix
// rounds, no arming, no merge.

/**
 * Reads the parked item's PR once per pass and finishes the item when it is merged. A
 * failed read is silent: the item is parked already, and its reason says why.
 */
export async function watchParked(engine, ctx, item) {
  if (!ctx.github || !item.pr) return false;
  let snapshot;
  try {
    snapshot = await engine.forge.readPullRequest(
      ctx.github,
      item.pr.number,
      engine.signal(),
    );
  } catch {
    return false;
  }
  if (engine.closed || snapshot.state !== "MERGED") return false;
  const cleared = engine.save(ctx, item, { needsOwner: null, forgeFailingSince: null });
  return engine.finish(ctx, cleared, snapshot);
}
