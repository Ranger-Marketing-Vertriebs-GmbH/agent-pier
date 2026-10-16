import { createContext, useContext, useEffect, useRef } from "react";
import { AssistantDrafts } from "./assistant-drafts.js";
// The event stream lives in its own context: `subscribe(listener)` hands every event
// to the listener, one call each, so two events of one chunk never merge into one
// render, and nothing but the listeners runs for a streamed token.
export const AssistantsStateContext = createContext(null);
export const AssistantEventsContext = createContext(null);
// One draft store for the page, so drafts survive the host being unmounted.
export const sharedDrafts = new AssistantDrafts();
// What consumers see until the lazily loaded host has published real data.
export const idleAssistants = {
  assistants: [],
  conversations: [],
  models: [],
  activity: {},
  runtime: { availability: "disabled", sync: "stale" },
  error: "",
  connected: true,
  drafts: sharedDrafts,
  refresh: async () => {},
};
export default function useAssistants() {
  return useContext(AssistantsStateContext) ?? idleAssistants;
}
/** Calls `listener(event)` for every assistant event while the host is there. */
export function useAssistantEvents(listener) {
  const subscribe = useContext(AssistantEventsContext)?.subscribe;
  const current = useRef(listener);
  useEffect(() => {
    current.current = listener;
  });
  useEffect(() => subscribe?.((event) => current.current(event)), [subscribe]);
}
