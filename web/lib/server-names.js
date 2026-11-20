import { useMemo } from "react";
import useLanguage from "./i18n/useLanguage.js";
import { serverMessagesVersion, serverText } from "./server-messages.js";

// Names AgentPier generates on the server ("Codex · Lokal", "Work · Anmeldung") come
// in German with their message key (`nameKey`, `nameArgs`); the browser shows them in
// its own language. A name without a key (one the owner typed) stays as it is.
export const localName = (record) =>
  record?.nameKey
    ? serverText(record.name, record.nameKey, record.nameArgs)
    : record?.name;

const localized = (records) => {
  if (!Array.isArray(records) || !records.some((record) => record?.nameKey))
    return records;
  return records.map((record) =>
    record?.nameKey ? { ...record, name: localName(record) } : record,
  );
};

/** The workspace state with its generated account and session names localized. */
export function localizeNames(state) {
  if (!state) return state;
  const accounts = localized(state.accounts),
    sessions = localized(state.sessions);
  return accounts === state.accounts && sessions === state.sessions
    ? state
    : { ...state, accounts, sessions };
}

/** localizeNames() kept while the state, the language and the server catalog stay. */
export function useLocalizedNames(state) {
  const language = useLanguage();
  const version = serverMessagesVersion();
  return useMemo(
    () => localizeNames(state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, language, version],
  );
}
