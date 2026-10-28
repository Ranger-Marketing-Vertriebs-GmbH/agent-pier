import { createContext, useContext } from "react";
import { AssistantDrafts } from "./assistant-drafts.js";
export const AssistantsStateContext = createContext(null);
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
  offline: false,
  histories: null,
  drafts: sharedDrafts,
  refresh: async () => {},
};
export default function useAssistants() {
  return useContext(AssistantsStateContext) ?? idleAssistants;
}
