// How AssistantService follows its Gateway: runtime status changes and the chat
// events of the current connection (streamed replies, finished runs, generated
// images). Extracted from assistant-service.js; `service` is the AssistantService.
import { confirmFromEvent } from "./run-confirmation.js";

/** The runtime status listener: readiness, failures and maintenance. */
export function runtimeStatusHandler(service) {
  return (state) => {
    if (service.maintenance) {
      // A maintenance restart replaces the client while readiness is absorbed
      // here, so subscriptions follow it now; leaving maintenance resyncs.
      if (state.availability === "ready") service.bindGateway();
      service.lastAvailability = state.availability;
      service.events.publish({ type: "runtime", ...state });
      return;
    }
    // Outstanding attempts become uncertain; clients only refetch on change.
    if (state.availability === "failed") {
      service.markOutstandingUnknown();
      service.changed();
    }
    service.events.publish({ type: "runtime", ...state });
    const becameReady =
      state.availability === "ready" && service.lastAvailability !== "ready";
    service.lastAvailability = state.availability;
    if (becameReady) {
      service.config.reset?.();
      service.bindGateway();
      service.gatewayEvents.ready();
      service.accounts
        ?.list()
        .then(() => service.changed())
        .catch(() => {});
      // A reconnect re-subscribes every session at once; a pass that started on
      // the previous connection must not absorb this one.
      service.sessionFailures.clear();
      // The start compiled the store; a level a lost apply left pending is checked.
      service.shellChanges.retry({ force: true }).catch(() => {});
      (service.reconciling || Promise.resolve())
        .catch(() => {})
        .then(() => service.reconcile())
        .catch(() => {});
    }
  };
}

/**
 * Subscribes to the current client's events: streamed reply deltas for the open
 * chat, reconciliation after a run ends and the images a run left behind.
 */
export function bindChatEvents(service) {
  service.unsubscribe?.();
  // A new connection starts every run with a snapshot; old baselines are stale.
  service.chatStreams.clear();
  service.feeds?.clearRuns();
  service.unsubscribe = service.runtime.client?.subscribe((event) => {
    const payload = event.payload;
    if (!payload?.sessionKey) return;
    const conversation = service.store
      .listConversations()
      .find((c) => c.runtimeSessionKey === payload.sessionKey);
    // A routine's own run session may leave images too (generated-images.js).
    if (!conversation) return service.generatedImages.observeRun(event);
    // Any frame of the turn's run proves a send whose acknowledgement was lost.
    confirmFromEvent(service, conversation, payload);
    // Only a run's first frame carries the whole reply; later ones carry what was
    // appended. The chat's live feed always holds the reply so far.
    const text =
      event.event === "chat" && payload.state === "delta"
        ? service.chatStreams.delta(payload)
        : undefined;
    if (text !== undefined) service.feeds?.stream(conversation.id, payload.runId, text);
    if (event.event === "chat" && ["final", "aborted", "error"].includes(payload.state)) {
      service.chatStreams.end(payload.runId);
      service.feeds?.endRun(conversation.id, payload.runId);
      // A run ending is activity, also one AgentPier did not send: a reminder, routine
      // or check-in delivered into the main chat (owner-privacy.js, agent-chats.js).
      // A released user's chat keeps no record of its use.
      if (!conversation.userReleased)
        service.store.updateConversation(conversation.id, {
          lastActivityAt: new Date(service.now?.() ?? Date.now()).toISOString(),
        });
      service.reconcile().catch(() => {});
      // An image_generate completion leaves its images here (generated-images.js).
      service.generatedImages.observe(conversation).catch(() => {});
    }
  });
}
