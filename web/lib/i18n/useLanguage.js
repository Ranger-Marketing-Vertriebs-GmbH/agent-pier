import { useSyncExternalStore } from "react";
import { getLanguage, subscribeLanguage } from "./index.js";
import { serverMessagesVersion, subscribeServerMessages } from "../server-messages.js";

export default function useLanguage() {
  // Stored server text switches to English once the lazily loaded catalog arrives.
  useSyncExternalStore(
    subscribeServerMessages,
    serverMessagesVersion,
    serverMessagesVersion,
  );
  return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
}
