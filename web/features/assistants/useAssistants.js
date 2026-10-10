import { createContext, useContext } from "react";
import { AssistantDrafts } from "./assistant-drafts.js";
// Streamed deltas change on every token; they live in their own context so only
// chat views re-render for them, never the list, sidebar or settings.
export const AssistantsStateContext = createContext(null);
export const AssistantEventsContext = createContext(null);
// One draft store for the page, so drafts survive the host being unmounted.
export const sharedDrafts = new AssistantDrafts();
// What consumers see until the lazily loaded host has published real data.
export const idleAssistants = {
  assistants: [],
  conversations: [],
  models: [],
  runtime: { availability: "disabled", sync: "stale" },
  error: "",
  connected: true,
  drafts: sharedDrafts,
  refresh: async () => {},
};
export const idleEvents = { lastEvent: null };
export default function useAssistants() {
  return useContext(AssistantsStateContext) ?? idleAssistants;
}
export function useAssistantEvent() {
  return useContext(AssistantEventsContext)?.lastEvent ?? null;
}
