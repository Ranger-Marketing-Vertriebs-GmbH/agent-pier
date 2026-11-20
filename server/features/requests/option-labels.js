import { requestCopy as copy } from "../../lib/i18n/de/requests.js";

// The stable identifiers of the option labels AgentPier itself gives a native
// permission prompt (Codex, OpenCode, Claude). An option carries one as `labelKey`
// beside its German `label`: the browser shows the label of the UI language
// (web/lib/i18n/*/requests.js `optionLabels`), Telegram the channel's
// (server/lib/i18n/*/requests.js). Labels the CLI wrote itself have no key.
export const optionLabelKeys = Object.freeze([
  "once",
  "turnAllow",
  "sessionAllow",
  "always",
  "deny",
  "cancel",
  "planAcceptEdits",
  "planApprove",
  "planKeep",
  "rememberSession",
  "rememberProject",
]);
const known = new Set(optionLabelKeys);

/** Whether `key` names one of these labels. */
export const optionLabelKey = (key) => typeof key === "string" && known.has(key);

/** An option's label fields for `key`: the German label and its identifier. */
export const optionLabel = (key) => ({ label: copy[key], labelKey: key });

/**
 * The label of `option` in `catalog` (a language's requestCopy): the label its key
 * names there, else the label it came with.
 */
export const localizedOptionLabel = (option, catalog) =>
  (optionLabelKey(option?.labelKey) && catalog?.[option.labelKey]) || option?.label;
