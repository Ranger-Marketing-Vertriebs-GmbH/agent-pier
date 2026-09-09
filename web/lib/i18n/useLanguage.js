import { useSyncExternalStore } from "react";
import { getLanguage, subscribeLanguage } from "./index.js";

export default function useLanguage() {
  return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
}
