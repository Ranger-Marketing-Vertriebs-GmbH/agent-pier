// Reconciliation of the agents' chats with the Gateway (AssistantService.reconcile):
// each chat's native session is subscribed and its latest history read, then the
// runs are reconciled. A full pass reads every open chat; the poll during a turn and
// a run's end read only the chats that need it, so a pass costs what is underway,
// not the number of chats.
import * as queuedDispatch from "./queued-dispatch.js";
import { reconcileRuns } from "./run-reconciler.js";
import { reconciledChanges } from "./conversation-feeds.js";
import { busyChats, chatBusy } from "./agent-chats.js";
import { keepChatOpen } from "./native-chat-archive.js";

const sessionRetryMs = 60000;

/**
 * Starts a pass, or joins the running one. `full` (the default: readiness,
 * maintenance, a cancel) reads every chat; otherwise only `chats` (a run ended
 * there), chats with work underway or a live feed, a session failure due for its
 * retry, and chats not yet subscribed on this connection. Work asked for while a
 * pass runs gets one more pass right after it.
 */
export function reconcileChats(service, { full = true, chats = [] } = {}) {
  service.reconcileDirty ??= new Set();
  for (const id of chats) service.reconcileDirty.add(id);
  if (full) service.reconcileFull = true;
  if (service.reconciling) {
    if (!full && !chats.length) return service.reconciling;
    service.reconcileNext ??= service.reconciling
      .catch(() => {})
      .then(() => {
        service.reconcileNext = null;
        return reconcileChats(service, { full: false });
      });
    return service.reconcileNext;
  }
  if (!service.runtime.client?.ready || service.closed || service.maintenance)
    return Promise.resolve();
  service.reconciling = pass(service).finally(() => {
    service.reconciling = null;
    // A turn that ended lets the conversation's queued message go out.
    queuedDispatch.dispatchQueued(service).catch(() => {});
  });
  return service.reconciling;
}

/**
 * Keeps one chat's native session open; true once it is (or the Gateway has no such
 * session). A failure, a concurrent reset that changed the session id among them,
 * leaves the chat for the next pass and is logged once per connection.
 */
async function keepOpen(service, client, c) {
  let current;
  try {
    current = service.store.storedConversation(c.id);
  } catch {
    return true;
  }
  // A chat deleted or released while the pass ran is left to its native delete.
  if (current.deletedAt || current.userReleased) return true;
  try {
    await keepChatOpen(client, c.runtimeSessionKey);
    service.keptOpen.add(c.id);
    service.keepOpenFailures?.delete(c.id);
    return true;
  } catch (error) {
    if (service.runtime.client === client && client.ready) {
      service.keepOpenFailures ??= new Set();
      if (!service.keepOpenFailures.has(c.id)) {
        service.keepOpenFailures.add(c.id);
        console.warn(
          `Agent chat ${c.id} could not be kept open natively (${
            error?.code || "RPC_FAILED"
          }); retrying on the next pass.`,
        );
      }
    }
    return false;
  }
}

async function pass(service) {
  const full = !!service.reconcileFull;
  const dirty = service.reconcileDirty;
  service.reconcileFull = false;
  service.reconcileDirty = new Set();
  const client = service.runtime.client;
  // Native subscriptions belong to one connection: a new client starts over.
  if (service.subscribedOn !== client) {
    service.subscribedOn = client;
    service.subscribed = new Set();
    service.keptOpen = new Set();
    service.keepOpenFailures = new Set();
  }
  service.keptOpen ??= new Set();
  // The chats whose history came from the cache: a full pass finds them anew, a
  // partial one reads them again with the chats it needs, so the flag covers every
  // chat and clears once the last one reads, and a chat that takes no live read
  // (archived, released) leaves it.
  if (full || !service.staleChats) service.staleChats = new Set();
  const stale = service.staleChats;
  const reads = new Map();
  const busy = busyChats(service);
  const watched = new Set(service.feeds?.entries?.keys() || []);
  for (const c of service.store.listConversations()) {
    // One unavailable session must not stall run reconciliation for the rest.
    if (service.closed) break;
    // A deleted user's chat waits only for its native delete (user-release.js).
    if (c.userReleased) {
      stale.delete(c.id);
      continue;
    }
    // Once per connection, archived chats too: pinned, a chat stays out of OpenClaw's
    // maintenance (its entry cap and disk budget included), and one it archived anyway
    // takes turns and deliveries again (native-chat-archive.js).
    if (!service.keptOpen.has(c.id) && !(await keepOpen(service, client, c))) {
      // A dropped connection is not a session fault; the reconnect checks anew.
      if (service.runtime.client !== client || !client.ready) break;
    }
    const working = chatBusy(service, c.id, busy);
    // An archived chat takes no turn: no live read unless work still reports into it.
    if (c.archivedAt && !working) {
      stale.delete(c.id);
      continue;
    }
    const failure = service.sessionFailures.get(c.id);
    if (service.now() < (failure?.retryAt ?? -Infinity)) continue;
    const subscribed = service.subscribed.has(c.id);
    if (!(
      full ||
      working ||
      failure ||
      !subscribed ||
      dirty.has(c.id) ||
      watched.has(c.id) ||
      stale.has(c.id)
    ))
      continue;
    // A full pass subscribes every chat again, as after a Gateway restart.
    if (full || !subscribed) {
      try {
        await client.call("sessions.messages.subscribe", { key: c.runtimeSessionKey });
        service.subscribed.add(c.id);
        service.sessionFailures.delete(c.id);
      } catch {
        // A dropped connection is not a session fault; the reconnect resubscribes.
        if (service.runtime.client !== client || !client.ready) break;
        service.subscribed.delete(c.id);
        service.sessionFailures.set(c.id, {
          diagnostic: "SESSION_UNAVAILABLE",
          retryAt: service.now() + sessionRetryMs,
        });
        continue;
      }
    }
    const history = await service.history(c.id);
    reads.set(c.id, history);
    if (history.stale) stale.add(c.id);
    else stale.delete(c.id);
  }
  await reconcileRuns(service);
  if (!service.closed) {
    const listed = new Set(service.store.listConversations().map((c) => c.id));
    for (const id of stale) if (!listed.has(id)) stale.delete(id);
    service.runtime.setState({ sync: stale.size ? "stale" : "current" });
    // The poll reconciles every 2 s during a turn: only the chats whose history
    // or turns changed read their feed again; the list hears of every pass.
    for (const id of reconciledChanges(service, reads)) service.feeds.invalidate(id);
    service.events.publish({ type: "change" });
  }
}
