import { startLiveTopic } from "../../web/lib/live/live-topic-reader.js";
import { fakeEnv } from "./fake-browser.js";

// The state machine behind useLiveTopic, against a fake LiveClient: pushed data,
// one GET after stale/changed, and the visible-only poll during a fallback.
export function fakeClient({ connected = false, fallback = false } = {}) {
  const subscriptions = [];
  let status = { connected, fallback };
  return {
    subscriptions,
    subscribe(topicId, listener, options) {
      const entry = { topicId, listener, options, active: true };
      subscriptions.push(entry);
      return () => (entry.active = false);
    },
    status: () => status,
    emit(event) {
      if (event.type === "status") status = { ...event, type: undefined };
      for (const entry of subscriptions) if (entry.active) entry.listener(event);
    },
  };
}
export function setup(
  topicId,
  { client = fakeClient(), responses = [], hidden = false, path } = {},
) {
  const fake = fakeEnv({ hidden });
  let clock = 0;
  const reads = [];
  const reports = [];
  const reader = startLiveTopic({
    topicId,
    path,
    client,
    env: { ...fake.env, now: () => clock },
    read: (path, signal) => {
      reads.push(path);
      const next = responses[Math.min(reads.length - 1, responses.length - 1)];
      return next ? next(signal) : Promise.resolve({ path });
    },
    report: (state) => reports.push(state),
  });
  return {
    fake,
    client,
    reader,
    reads,
    reports,
    last: () => reports.at(-1),
    tick: (ms) => (clock += ms),
  };
}
export const ok = (data) => async () => data;
export const hang = (signal) =>
  new Promise((_resolve, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason)),
  );
