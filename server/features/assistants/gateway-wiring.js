// How AssistantService follows its Gateway: runtime status changes and the chat
// events of the current connection (streamed replies, finished runs, generated
// images). Extracted from assistant-service.js; `service` is the AssistantService.
import { confirmFromEvent } from "./run-confirmation.js";
import { admissionDone } from "./agent-admission.js";

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
      // Once the Gateway admitted or refused its agents (agent-admission.js), the
      // list shows the refused ones and every chat subscribes again at once: one
      // refused while its agent was still being admitted is no session fault.
      const client = service.runtime.client;
      admissionDone(client).then((waited) => {
        if (client !== service.runtime.client || service.maintenance) return;
        service.changed();
        if (!waited) return;
        service.sessionFailures.clear();
        (service.reconciling || Promise.resolve())
          .catch(() => {})
          .then(() => service.reconcile())
          .catch(() => {});
      });
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
  service.runSteps.reconnected();
  service.unsubscribe = service.runtime.client?.subscribe((event) => {
    const payload = event.payload;
    if (!payload?.sessionKey) return;
    // The session key is indexed: every streamed delta looks its chat up.
    const conversation = service.store.conversationOfSession(payload.sessionKey);
    // A routine's own run session may leave images too (generated-images.js).
    if (!conversation) return service.generatedImages.observeRun(event);
    // Any frame of the turn's run proves a send whose acknowledgement was lost.
    confirmFromEvent(service, conversation, payload);
    // Its live steps, and any frame at all as a sign of life (run-steps.js).
    publishSteps(service, conversation, event);
    // Only a run's first frame carries the whole reply; later ones carry what was
    // appended. The chat's live feed always holds the reply so far.
    const text =
      event.event === "chat" && payload.state === "delta"
        ? service.chatStreams.delta(payload)
        : undefined;
    if (text !== undefined) service.feeds?.stream(conversation.id, payload.runId, text);
    if (event.event === "chat" && ["final", "aborted", "error"].includes(payload.state)) {
      service.chatStreams.end(payload.runId);
      service.runSteps.end(payload.runId);
      // Why it failed, for its turn (run-reconciler.js); kept for a few runs only.
      if (payload.state === "error" && payload.errorKind === "timeout") {
        const failures = (service.runFailures ??= new Map());
        failures.set(payload.runId, "timeout");
        if (failures.size > 64) failures.delete(failures.keys().next().value);
      }
      // A reply that ended the run while the stall guard aborted it is no stall.
      if (
        payload.state === "final" &&
        service.runFailures?.get(payload.runId) === "stalled"
      )
        service.runFailures.delete(payload.runId);
      service.feeds?.endRun(conversation.id, payload.runId);
      // A run ending is activity, also one AgentPier did not send: a reminder, routine
      // or check-in delivered into the main chat (owner-privacy.js, agent-chats.js).
      // A released user's chat keeps no record of its use.
      if (!conversation.userReleased)
        service.store.updateConversation(conversation.id, {
          lastActivityAt: new Date(service.now?.() ?? Date.now()).toISOString(),
        });
      // Only this chat and those with work underway are read again (chat-reconcile.js).
      service.reconcile({ full: false, chats: [conversation.id] }).catch(() => {});
      // An image_generate completion leaves its images here (generated-images.js);
      // a released user's files went with her and are never copied back.
      if (!conversation.userReleased)
        service.generatedImages.observe(conversation).catch(() => {});
    }
  });
}

// A run's steps go to its chat when they change, and at most every `aliveMs` while
// only signs of life arrive (thinking, a long reply), so the chat's quiet time stays
// true without a frame per token.
const aliveMs = 15000;
function publishSteps(service, conversation, event) {
  const observed = service.runSteps.observe(event);
  if (!observed) return;
  const now = service.now?.() ?? Date.now();
  const sent = (service.stepsSent ??= new Map());
  const last = sent.get(observed.runId);
  if (!observed.changed && last !== undefined && now - last < aliveMs) return;
  sent.delete(observed.runId);
  sent.set(observed.runId, now);
  if (sent.size > 64) sent.delete(sent.keys().next().value);
  service.feeds?.steps(
    conversation.id,
    observed.runId,
    service.runSteps.view(observed.runId),
  );
}
