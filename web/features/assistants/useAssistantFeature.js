import { useEffect, useSyncExternalStore } from "react";
import { assistantApi } from "./assistant-api.js";
// A client-side code (the server never sends it) for "the switch could not be read".
export const FEATURE_CHECK_FAILED = "FEATURE_CHECK_FAILED";
// One shared opt-in state: the shell, sidebar, accounts and settings all follow it,
// and it is the only assistant request made while agents are switched off.
let state = { enabled: false, error: null, loading: true, saving: false };
let started = false;
let checking = false;
let timer = null;
let attempts = 0;
const listeners = new Set();
function publish(next) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}
function check() {
  if (checking) return;
  checking = true;
  clearTimeout(timer);
  assistantApi
    .feature()
    .then((feature) => {
      attempts = 0;
      publish({
        enabled: !!feature.enabled,
        error: feature.error || null,
        loading: false,
      });
    })
    .catch(() => {
      // Unknown is not off: report it, keep the app usable and try again with backoff.
      publish({ enabled: false, error: FEATURE_CHECK_FAILED, loading: false });
      timer = setTimeout(check, Math.min(1000 * 2 ** attempts++, 30000));
    })
    .finally(() => {
      checking = false;
    });
}
function start() {
  if (started) return;
  started = true;
  check();
  window.addEventListener("focus", retry);
}
function retry() {
  if (state.error === FEATURE_CHECK_FAILED) check();
}
async function setEnabled(enabled) {
  publish({ saving: true });
  try {
    const feature = await assistantApi.setFeature(enabled);
    publish({ enabled: !!feature.enabled, error: feature.error || null });
  } finally {
    publish({ saving: false });
  }
}
const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export default function useAssistantFeature() {
  const current = useSyncExternalStore(subscribe, () => state);
  useEffect(start, []);
  return { ...current, setEnabled, retry };
}
