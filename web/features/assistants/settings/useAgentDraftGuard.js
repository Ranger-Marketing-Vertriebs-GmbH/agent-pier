import useUnsavedChangesGuard from "../../../lib/settings/useUnsavedChangesGuard.js";
import { staysOnAgentTab } from "./agent-settings-fields.js";

/** The unsaved-changes guard of one agent tab (or one subpage with its own draft). */
export default function useAgentDraftGuard({
  draft,
  assistantId,
  tab,
  page,
  label,
  save,
}) {
  return useUnsavedChangesGuard({
    draft,
    tab: label,
    save,
    stays: staysOnAgentTab(assistantId, tab, page),
  });
}
